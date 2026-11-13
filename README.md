# Air Checker Bot

Bot del server de **Air Checker** para drops de usernames.

| Comando | Qué hace |
|---|---|
| `/check username` | Responde `` `@username` > Available `` o `` Taken `` |
| `/purge [canal] [cantidad]` | Vacía el canal entero (o los últimos N). Los fijados se quedan. Necesita *Gestionar mensajes* |
| `!drophere` | Ese canal pasa a ser el de drops (solo admins) |

## Cómo llegan los hits

1. Escribe `!drophere` en el canal de drops.
2. El bot crea un webhook ahí y te lo manda por **DM**.
3. Pega ese link en `webhook.txt` de tu checker (o pon `CHECKER_DIR` y lo escribe solo).
4. Cada hit del checker cae en el canal; el bot lo borra y lo publica como embed:
   `@rol Hit `@username`` + embed *Discord Username*.

No hace falta tocar el checker: el bot lee cualquier mensaje del webhook con `` `nombre` ``.
Tras un reinicio el bot recupera el canal solo (busca su webhook *Air Checker Drops*).

## Setup

1. [Developer Portal](https://discord.com/developers/applications) > tu app > **Bot**:
   activa **Message Content Intent**.
2. Invita el bot con permisos: Ver canales, Enviar mensajes, Insertar enlaces, Gestionar mensajes,
   Leer historial, Gestionar webhooks, Mencionar @everyone/roles (scope `bot` + `applications.commands`).
3. El rol del bot tiene que poder mencionar el rol de hits (o marca el rol como *mencionable*).
4. `npm install`, copia `.env.example` a `.env`, rellena y `npm start`.

### Render
- Build: `npm install` · Start: `npm start`
- Variables: `DISCORD_TOKEN`, `GUILD_ID`, `HIT_ROLE_ID`
- UptimeRobot a la URL del servicio para que no se duerma.
