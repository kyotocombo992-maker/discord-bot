import "dotenv/config";
import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  PermissionsBitField,
} from "discord.js";
import {
  joinVoiceChannel,
  getVoiceConnection,
  VoiceConnectionStatus,
  entersState,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  NoSubscriberBehavior,
} from "@discordjs/voice";
import playdl from "play-dl";

// ─── Music queue (one per guild) ─────────────────────────────────────────────

const queues = new Map();

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function createQueue(guildId) {
  const player = createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
  });
  const queue = { player, tracks: [], currentTrack: null, looping: false };
  queues.set(guildId, queue);

  player.on(AudioPlayerStatus.Idle, () => {
    const q = queues.get(guildId);
    if (!q) return;
    if (q.looping && q.currentTrack) {
      playTrack(guildId, q.currentTrack).catch(console.error);
      return;
    }
    const next = q.tracks.shift();
    if (next) playTrack(guildId, next).catch(console.error);
    else q.currentTrack = null;
  });

  player.on("error", (err) => {
    console.error("Audio player error:", err);
    const q = queues.get(guildId);
    if (!q) return;
    const next = q.tracks.shift();
    if (next) playTrack(guildId, next).catch(console.error);
    else q.currentTrack = null;
  });

  return queue;
}

async function playTrack(guildId, track) {
  const connection = getVoiceConnection(guildId);
  if (!connection) return;
  const q = queues.get(guildId) ?? createQueue(guildId);
  q.currentTrack = track;
  const stream = await playdl.stream(track.url, { quality: 2 });
  const resource = createAudioResource(stream.stream, { inputType: stream.type });
  q.player.play(resource);
  connection.subscribe(q.player);
}

async function enqueue(guildId, url, requestedBy) {
  const info = await playdl.video_info(url);
  const track = {
    url,
    title: info.video_details.title ?? "Unknown",
    duration: formatDuration(info.video_details.durationInSec),
    requestedBy,
  };
  let q = queues.get(guildId);
  const isPlaying = q?.currentTrack !== null;
  if (!q) q = createQueue(guildId);
  if (!isPlaying) {
    await playTrack(guildId, track);
    return { track, position: 0 };
  }
  q.tracks.push(track);
  return { track, position: q.tracks.length };
}

function skipTrack(guildId) {
  const q = queues.get(guildId);
  if (!q?.currentTrack) return null;
  q.player.stop();
  return q.currentTrack;
}

function stopPlayback(guildId) {
  const q = queues.get(guildId);
  if (!q) return;
  q.tracks = [];
  q.currentTrack = null;
  q.player.stop();
  queues.delete(guildId);
}

function getQueue(guildId) {
  const q = queues.get(guildId);
  return { current: q?.currentTrack ?? null, upcoming: q?.tracks ?? [], looping: q?.looping ?? false };
}

function toggleLoop(guildId) {
  const q = queues.get(guildId);
  if (!q) return false;
  q.looping = !q.looping;
  return q.looping;
}

// ─── Helper: join voice channel ───────────────────────────────────────────────

async function joinChannel(voiceChannel) {
  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: voiceChannel.guild.id,
    adapterCreator: voiceChannel.guild.voiceAdapterCreator,
  });
  await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
  return connection;
}

// ─── Commands ─────────────────────────────────────────────────────────────────

const PREFIX = "!";

const COMMANDS = {
  ping: {
    description: "Check bot latency",
    usage: "!ping",
    async execute(message) {
      const sent = await message.reply("Pinging…");
      await sent.edit(
        `Pong! Latency: **${sent.createdTimestamp - message.createdTimestamp}ms** | API: **${Math.round(client.ws.ping)}ms**`
      );
    },
  },

  help: {
    description: "List all commands or get info about one",
    usage: "!help [command]",
    async execute(message, args) {
      if (args.length > 0) {
        const cmd = COMMANDS[args[0].toLowerCase()];
        if (!cmd) { await message.reply(`Unknown command: \`${args[0]}\``); return; }
        await message.reply(`**${args[0]}**\n${cmd.description}\nUsage: \`${cmd.usage}\``);
        return;
      }
      const list = Object.entries(COMMANDS)
        .map(([name, cmd]) => `\`${PREFIX}${name}\` — ${cmd.description}`)
        .join("\n");
      await message.reply(`**Available commands:**\n${list}`);
    },
  },

  say: {
    description: "Make the bot send a message",
    usage: "!say <message>",
    async execute(message, args) {
      if (!args.length) { await message.reply("Please provide a message."); return; }
      if (!message.channel.isTextBased() || message.channel.isDMBased()) return;
      await message.delete().catch(() => null);
      await message.channel.send(args.join(" "));
    },
  },

  clear: {
    description: "Delete messages from this channel (1–100)",
    usage: "!clear <amount>",
    async execute(message, args) {
      if (!message.member?.permissions.has(PermissionsBitField.Flags.ManageMessages)) {
        await message.reply("You need the **Manage Messages** permission."); return;
      }
      const amount = parseInt(args[0]);
      if (isNaN(amount) || amount < 1 || amount > 100) {
        await message.reply("Please provide a number between 1 and 100."); return;
      }
      if (!message.channel.isTextBased() || message.channel.isDMBased()) return;
      const deleted = await message.channel.bulkDelete(amount + 1, true);
      const reply = await message.channel.send(`Deleted **${deleted.size - 1}** message(s).`);
      setTimeout(() => reply.delete().catch(() => null), 4000);
    },
  },

  join: {
    description: "Join your current voice channel",
    usage: "!join",
    async execute(message) {
      const voiceChannel = message.member?.voice.channel;
      if (!voiceChannel) { await message.reply("You need to be in a voice channel first."); return; }
      try {
        await joinChannel(voiceChannel);
        await message.reply(`Joined **${voiceChannel.name}**!`);
      } catch {
        await message.reply("Failed to join the voice channel. Make sure I have **Connect** permission.");
      }
    },
  },

  leave: {
    description: "Leave the current voice channel",
    usage: "!leave",
    async execute(message) {
      const connection = getVoiceConnection(message.guildId);
      if (!connection) { await message.reply("I'm not in a voice channel."); return; }
      connection.destroy();
      await message.reply("Left the voice channel.");
    },
  },

  play: {
    description: "Play a YouTube video/song in your voice channel",
    usage: "!play <YouTube URL>",
    async execute(message, args) {
      if (!message.guildId) { await message.reply("Server only."); return; }
      if (!args.length) { await message.reply("Provide a YouTube URL. Usage: `!play <URL>`"); return; }
      const voiceChannel = message.member?.voice.channel;
      if (!voiceChannel) { await message.reply("You need to be in a voice channel first."); return; }
      if (!getVoiceConnection(message.guildId)) {
        try { await joinChannel(voiceChannel); }
        catch { await message.reply("Failed to join your voice channel."); return; }
      }
      const loading = await message.reply("Fetching track info…");
      try {
        const { track, position } = await enqueue(message.guildId, args[0], message.author.username);
        if (position === 0) {
          await loading.edit(`Now playing: **${track.title}** \`[${track.duration}]\` — requested by ${track.requestedBy}`);
        } else {
          await loading.edit(`Added to queue (#${position}): **${track.title}** \`[${track.duration}]\``);
        }
      } catch (err) {
        console.error("Play error:", err);
        await loading.edit("Could not play that URL. Make sure it's a valid public YouTube link.");
      }
    },
  },

  skip: {
    description: "Skip the currently playing track",
    usage: "!skip",
    async execute(message) {
      const skipped = skipTrack(message.guildId);
      if (!skipped) { await message.reply("Nothing is playing right now."); return; }
      await message.reply(`Skipped **${skipped.title}**.`);
    },
  },

  stop: {
    description: "Stop playback and clear the queue",
    usage: "!stop",
    async execute(message) {
      stopPlayback(message.guildId);
      await message.reply("Stopped playback and cleared the queue.");
    },
  },

  queue: {
    description: "Show the current queue",
    usage: "!queue",
    async execute(message) {
      const { current, upcoming, looping } = getQueue(message.guildId);
      if (!current) { await message.reply("The queue is empty."); return; }
      const lines = [`**Now playing${looping ? " (looping)" : ""}:** ${current.title} \`[${current.duration}]\``];
      if (upcoming.length) {
        lines.push("**Up next:**");
        upcoming.slice(0, 10).forEach((t, i) => lines.push(`${i + 1}. ${t.title} \`[${t.duration}]\` — ${t.requestedBy}`));
        if (upcoming.length > 10) lines.push(`…and ${upcoming.length - 10} more`);
      } else {
        lines.push("No more tracks queued.");
      }
      await message.reply(lines.join("\n"));
    },
  },

  loop: {
    description: "Toggle looping the current track",
    usage: "!loop",
    async execute(message) {
      const on = toggleLoop(message.guildId);
      await message.reply(on ? "Looping is now **on**." : "Looping is now **off**.");
    },
  },

  serverinfo: {
    description: "Show server information",
    usage: "!serverinfo",
    async execute(message) {
      if (!message.guild) { await message.reply("Server only."); return; }
      await message.guild.fetch();
      await message.reply([
        `**Server:** ${message.guild.name}`,
        `**Members:** ${message.guild.memberCount}`,
        `**Created:** ${message.guild.createdAt.toDateString()}`,
        `**Channels:** ${message.guild.channels.cache.size}`,
        `**Roles:** ${message.guild.roles.cache.size}`,
      ].join("\n"));
    },
  },

  userinfo: {
    description: "Show info about a user (defaults to yourself)",
    usage: "!userinfo [@user]",
    async execute(message) {
      const target = message.mentions.members?.first()?.user ?? message.author;
      const member = message.guild?.members.cache.get(target.id);
      await message.reply([
        `**User:** ${target.tag}`,
        `**ID:** ${target.id}`,
        `**Joined Discord:** ${target.createdAt.toDateString()}`,
        member ? `**Joined Server:** ${member.joinedAt?.toDateString() ?? "Unknown"}` : "",
        `**Bot:** ${target.bot ? "Yes" : "No"}`,
      ].filter(Boolean).join("\n"));
    },
  },
};

// ─── Client setup ─────────────────────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});

client.once(Events.ClientReady, (c) => {
  console.log(`Logged in as ${c.user.tag}`);
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (!message.content.startsWith(PREFIX)) return;
  const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
  const commandName = args.shift()?.toLowerCase();
  if (!commandName) return;
  const command = COMMANDS[commandName];
  if (!command) return;
  try {
    await command.execute(message, args);
  } catch (err) {
    console.error(`Error running !${commandName}:`, err);
    await message.reply("An error occurred while running that command.").catch(() => null);
  }
});

client.on(Events.Error, (err) => console.error("Discord error:", err));

// ─── Start ────────────────────────────────────────────────────────────────────

const token = process.env.DISCORD_BOT_TOKEN;
if (!token) {
  console.error("DISCORD_BOT_TOKEN is not set in your .env file.");
  process.exit(1);
}

client.login(token);
