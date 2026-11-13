// Air Checker Bot — drops de usernames para el server de Air Checker
// Comandos:
//   /check username   -> mira si un username de Discord está libre:  `@username` > Available / Taken
//   /purge [canal] [cantidad] -> vacía un canal (todo, o los últimos N mensajes). Solo el rol PURGE_ROLE_ID
//   Auto rol         -> cada miembro nuevo recibe HIT_ROLE_ID
//   !drophere         -> este canal pasa a ser el de drops. El bot crea un webhook aquí y te lo manda por DM:
//                        ese link va en webhook.txt del checker. Cada hit que mande el checker, el bot lo
//                        borra y lo vuelve a publicar como embed mencionando el rol de drops.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const http = require('http');
const {
  Client, GatewayIntentBits, Partials, EmbedBuilder, PermissionFlagsBits,
  SlashCommandBuilder, ChannelType, REST, Routes, MessageFlags, InteractionContextType,
} = require('discord.js');

const TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID || '';              // opcional: registra los slash al instante en ese server
const HIT_ROLE_ID = process.env.HIT_ROLE_ID || '1570697678977769502';    // rol que se menciona en cada hit y se da al entrar
const PURGE_ROLE_ID = process.env.PURGE_ROLE_ID || '1570183686207574037'; // único rol que puede usar /purge
const CHECKER_DIR = process.env.CHECKER_DIR || '';        // opcional: si el bot corre en tu PC, escribe webhook.txt solo
const PREFIX = '!';
const HOOK_NAME = 'Air Checker Drops';
const COLOR = 0xe84a5f;                                   // rojo del logo de Air Checker
const ENDPOINT = 'https://discord.com/api/v9/unique-username/username-attempt-unauthed';
const VALID = /^(?!.*\.\.)[a-z0-9_.]{2,32}$/;

if (!TOKEN) {
  console.error('Falta DISCORD_TOKEN (ponlo en .env o en las variables de entorno).');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,   // hay que activarlo en el Developer Portal (Bot > Privileged Gateway Intents)
    GatewayIntentBits.GuildWebhooks,
    GatewayIntentBits.GuildMembers,     // privilegiado: Server Members Intent (para el auto rol)
  ],
  partials: [Partials.Channel],
});

const sleep = ms => new Promise(r => setTimeout(r, ms));

// guildId -> { channelId, webhookId }
// No se guarda en disco: al arrancar se reconstruye buscando el webhook "Air Checker Drops" del bot.
// Así sobrevive a reinicios/redeploys de Render sin base de datos.
const drops = new Map();

// ---------------- slash commands ----------------
const commands = [
  new SlashCommandBuilder()
    .setName('check')
    .setDescription('Mira si un username de Discord está disponible')
    .addStringOption(o => o.setName('username').setDescription('El username (sin @)').setRequired(true).setMaxLength(33)),
  new SlashCommandBuilder()
    .setName('purge')
    .setDescription('Vacía los mensajes de un canal')
    .setContexts(InteractionContextType.Guild)
    .addChannelOption(o => o.setName('canal').setDescription('Canal a vaciar (por defecto este)')
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
    .addIntegerOption(o => o.setName('cantidad').setDescription('Solo los últimos N mensajes (vacío = todo el canal)')
      .setMinValue(1).setMaxValue(10000)),
].map(c => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  const route = GUILD_ID
    ? Routes.applicationGuildCommands(client.user.id, GUILD_ID)
    : Routes.applicationCommands(client.user.id);
  await rest.put(route, { body: commands });
  console.log(`Slash commands registrados ${GUILD_ID ? 'en el server ' + GUILD_ID : 'globalmente (pueden tardar en salir)'}`);
}

// ---------------- check de username ----------------
async function checkUsername(name) {
  for (let i = 0; i < 4; i++) {
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        },
        body: JSON.stringify({ username: name }),
        signal: AbortSignal.timeout(10000),
      });
      if (res.status === 429) {
        const j = await res.json().catch(() => ({}));
        await sleep(Math.min(Math.ceil((Number(j.retry_after) || 2) * 1000) + 100, 8000));
        continue;
      }
      if (res.status === 400) return 'invalid';
      if (res.ok) {
        const j = await res.json().catch(() => null);
        if (j && typeof j.taken === 'boolean') return j.taken ? 'taken' : 'available';
      }
      await sleep(1500);
    } catch {
      await sleep(1500);
    }
  }
  return 'error';
}

const RESULT = {
  available: { label: 'Available', emoji: '🟢', color: 0x3ba55d },
  taken: { label: 'Taken', emoji: '🔴', color: 0xed4245 },
  invalid: { label: 'Invalid', emoji: '⚪', color: 0x747f8d },
  error: { label: 'Error (Discord no respondió, prueba otra vez)', emoji: '🟡', color: 0xfaa61a },
};

async function onCheck(interaction) {
  const name = interaction.options.getString('username').trim().replace(/^@/, '').toLowerCase();
  await interaction.deferReply();
  const result = VALID.test(name) ? await checkUsername(name) : 'invalid';
  const r = RESULT[result];
  const embed = new EmbedBuilder()
    .setColor(r.color)
    .setDescription(`\`@${name}\` > **${r.label}** ${r.emoji}`);
  await interaction.editReply({ embeds: [embed] });
}

// ---------------- purge ----------------
async function onPurge(interaction) {
  if (!interaction.member?.roles?.cache?.has(PURGE_ROLE_ID)) {
    return interaction.reply({ content: `Solo <@&${PURGE_ROLE_ID}> puede usar \`/purge\`.`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  }
  const channel = interaction.options.getChannel('canal') || interaction.channel;
  const amount = interaction.options.getInteger('cantidad');

  const me = interaction.guild.members.me;
  const perms = channel.permissionsFor(me);
  if (!perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageMessages, PermissionFlagsBits.ReadMessageHistory])) {
    return interaction.reply({ content: `No tengo permisos de **Gestionar mensajes / Ver historial** en ${channel}.`, flags: MessageFlags.Ephemeral });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const limit = amount ?? Infinity;
  const twoWeeks = Date.now() - 14 * 24 * 60 * 60 * 1000 + 60_000;
  let deleted = 0;
  let lastProgress = Date.now();

  // Si se purga el canal donde se ejecutó el comando, no borres la respuesta del propio comando
  const skipId = interaction.channelId === channel.id ? (await interaction.fetchReply().catch(() => null))?.id : null;

  while (deleted < limit) {
    const batch = await channel.messages.fetch({ limit: 100 }).catch(() => null);
    if (!batch || !batch.size) break;
    let msgs = [...batch.values()].filter(m => m.id !== skipId && !m.pinned).slice(0, limit - deleted);
    if (!msgs.length) break;

    // Los de menos de 14 días se borran de 100 en 100; los viejos uno por uno (límite de Discord)
    const recent = msgs.filter(m => m.createdTimestamp > twoWeeks);
    const old = msgs.filter(m => m.createdTimestamp <= twoWeeks);

    if (recent.length >= 2) {
      const res = await channel.bulkDelete(recent.map(m => m.id), true).catch(() => null);
      deleted += res?.size || 0;
    } else if (recent.length === 1) {
      if (await recent[0].delete().then(() => true).catch(() => false)) deleted++;
    }
    for (const m of old) {
      if (deleted >= limit) break;
      if (await m.delete().then(() => true).catch(() => false)) deleted++;
    }

    if (Date.now() - lastProgress > 4000) {
      lastProgress = Date.now();
      interaction.editReply(`🧹 Borrando en ${channel}... **${deleted}** mensajes`).catch(() => {});
    }
    // Si en este lote no se pudo borrar nada, para (evita bucle infinito)
    if (batch.size && !recent.length && !old.length) break;
  }

  await interaction.editReply(`✅ ${channel} vaciado: **${deleted}** mensajes borrados${amount ? '' : ' (los fijados se dejan)'}.`);
}

// ---------------- !drophere ----------------
async function restoreDrops() {
  for (const guild of client.guilds.cache.values()) {
    try {
      const hooks = await guild.fetchWebhooks();
      const mine = hooks.find(w => w.owner?.id === client.user.id && w.name === HOOK_NAME);
      if (mine) {
        drops.set(guild.id, { channelId: mine.channelId, webhookId: mine.id });
        console.log(`[${guild.name}] canal de drops: #${guild.channels.cache.get(mine.channelId)?.name || mine.channelId}`);
      }
    } catch {
      // sin permiso de Gestionar webhooks en ese server
    }
  }
}

function writeCheckerWebhook(url) {
  if (!CHECKER_DIR) return false;
  try {
    fs.writeFileSync(path.join(CHECKER_DIR, 'webhook.txt'), url + '\n');
    return true;
  } catch (e) {
    console.error('No pude escribir webhook.txt:', e.message);
    return false;
  }
}

async function onDropHere(message) {
  const member = message.member;
  if (!member?.permissions.has(PermissionFlagsBits.ManageGuild)) {
    return message.reply('Solo admins (Gestionar servidor) pueden usar `!drophere`.').catch(() => {});
  }
  const channel = message.channel;
  const me = message.guild.members.me;
  const perms = channel.permissionsFor(me);
  if (!perms?.has([PermissionFlagsBits.ManageWebhooks, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ManageMessages])) {
    return message.reply('Me faltan permisos en este canal: **Gestionar webhooks, Enviar mensajes, Insertar enlaces y Gestionar mensajes**.').catch(() => {});
  }

  // Quita los webhooks de drops viejos (de este u otro canal) para que solo haya uno
  try {
    const hooks = await message.guild.fetchWebhooks();
    for (const w of hooks.values()) {
      if (w.owner?.id === client.user.id && w.name === HOOK_NAME) await w.delete('Nuevo canal de drops').catch(() => {});
    }
  } catch {}

  const hook = await channel.createWebhook({ name: HOOK_NAME, reason: `!drophere por ${message.author.tag}` });
  drops.set(message.guild.id, { channelId: channel.id, webhookId: hook.id });

  const wrote = writeCheckerWebhook(hook.url);
  let dmOk = false;
  try {
    await message.author.send({
      embeds: [new EmbedBuilder()
        .setColor(COLOR)
        .setTitle('Webhook de drops')
        .setDescription(
          `Canal: <#${channel.id}> en **${message.guild.name}**\n\n` +
          `Pega esto en \`webhook.txt\` de tu checker (reemplaza el que había):\n\`\`\`\n${hook.url}\n\`\`\`` +
          (wrote ? '\n✅ Ya lo escribí yo en `webhook.txt`.' : '') +
          '\nNo lo compartas: con este link cualquiera puede mandar mensajes al canal.'
        )],
    });
    dmOk = true;
  } catch {}

  await message.delete().catch(() => {});
  const note = await channel.send({
    embeds: [new EmbedBuilder()
      .setColor(COLOR)
      .setDescription(
        `📍 Los hits del checker caerán en este canal y mencionarán <@&${HIT_ROLE_ID}>.\n` +
        (dmOk ? `${message.author}, te mandé el webhook por DM.` : `${message.author}, no pude mandarte DM: abre tus DMs y vuelve a usar \`!drophere\`.`) +
        (wrote ? '\n`webhook.txt` actualizado.' : '')
      )],
    allowedMentions: { parse: [] },
  });
  setTimeout(() => note.delete().catch(() => {}), 15000);
}

// ---------------- relay de hits ----------------
// El checker manda "... hit `username`" al webhook. El bot borra ese mensaje y lo publica bonito.
const hitQueue = [];
let pumping = false;

async function pumpHits() {
  if (pumping) return;
  pumping = true;
  while (hitQueue.length) {
    const { channel, name } = hitQueue.shift();
    const embed = new EmbedBuilder()
      .setColor(COLOR)
      .setTitle('Hit')
      .setDescription(`\`@${name}\`\n<@&${HIT_ROLE_ID}>`);
    // Una mención dentro de una embed no notifica. Truco: se manda con el rol en el texto (eso hace el ping)
    // y al instante se edita para dejar solo la embed. La notificación ya llegó.
    const msg = await channel.send({
      content: `<@&${HIT_ROLE_ID}>`,
      embeds: [embed],
      allowedMentions: { roles: [HIT_ROLE_ID] },
    }).catch(e => { console.error('No pude mandar el hit:', e.message); return null; });
    if (msg) await msg.edit({ content: '', embeds: [embed] }).catch(() => {});
  }
  pumping = false;
}

function handleHookMessage(message) {
  const drop = drops.get(message.guildId);
  if (!drop || message.webhookId !== drop.webhookId) return false;

  const names = [...message.content.matchAll(/`@?([a-z0-9_.]{2,32})`/gi)].map(m => m[1].toLowerCase());
  if (!names.length) return true;
  message.delete().catch(() => {});
  for (const name of names) hitQueue.push({ channel: message.channel, name });
  pumpHits();
  return true;
}

// ---------------- eventos ----------------
client.once('clientReady', async () => {
  console.log(`Conectado como ${client.user.tag}`);
  client.user.setActivity('drops 4c · Air Checker');
  await registerCommands().catch(e => console.error('Error registrando comandos:', e.message));
  await restoreDrops();
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  try {
    if (interaction.commandName === 'check') await onCheck(interaction);
    else if (interaction.commandName === 'purge') await onPurge(interaction);
  } catch (e) {
    console.error(e);
    const msg = { content: 'Algo falló: ' + e.message, flags: MessageFlags.Ephemeral };
    if (interaction.deferred || interaction.replied) interaction.editReply(msg).catch(() => {});
    else interaction.reply(msg).catch(() => {});
  }
});

client.on('messageCreate', async message => {
  if (!message.guild) return;
  if (message.webhookId) { handleHookMessage(message); return; }
  if (message.author.bot) return;
  if (message.content.trim().toLowerCase() === PREFIX + 'drophere') {
    try { await onDropHere(message); } catch (e) {
      console.error(e);
      message.reply('No pude configurar el canal: ' + e.message).catch(() => {});
    }
  }
});

// Auto rol: todo el que entra recibe el rol de hits
client.on('guildMemberAdd', async member => {
  if (member.user.bot) return;
  await member.roles.add(HIT_ROLE_ID, 'Auto rol de Air Checker')
    .catch(e => console.error(`No pude dar el rol a ${member.user.tag}:`, e.message));
});

// Si alguien borra el webhook a mano, se olvida el canal
client.on('webhooksUpdate', async channel => {
  const drop = drops.get(channel.guildId);
  if (!drop || drop.channelId !== channel.id) return;
  const hooks = await channel.fetchWebhooks().catch(() => null);
  if (hooks && !hooks.has(drop.webhookId)) drops.delete(channel.guildId);
});

// ---------------- keep-alive (Render + UptimeRobot) ----------------
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end(client.isReady() ? 'Air Checker Bot online' : 'starting');
}).listen(PORT, () => console.log(`Keep-alive en el puerto ${PORT}`));

// Auto-ping: Render free duerme el servicio tras 15 min sin visitas. Render pone RENDER_EXTERNAL_URL solo,
// así que el bot se visita a sí mismo cada 10 min y no hace falta UptimeRobot.
const SELF_URL = process.env.RENDER_EXTERNAL_URL || process.env.SELF_URL;
if (SELF_URL) {
  setInterval(() => {
    fetch(SELF_URL, { signal: AbortSignal.timeout(15000) }).catch(() => {});
  }, 10 * 60 * 1000);
  console.log(`Auto-ping activo -> ${SELF_URL}`);
}

process.on('unhandledRejection', e => console.error('unhandledRejection:', e));
client.login(TOKEN);
