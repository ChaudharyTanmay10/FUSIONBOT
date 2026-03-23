const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const crypto = require('crypto');
const { spawn, execSync, exec } = require('child_process');
const nodemailer = require('nodemailer');

// HARDWARE ACCELERATION: Allow 10,000+ simultaneous connections
http.globalAgent.maxSockets = Infinity;
https.globalAgent.maxSockets = Infinity;

// ==========================================
// 1. DISCORD BOT IMPORTS & CONFIG
// ==========================================
const { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, Partials } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus } = require('@discordjs/voice');

// YOUR BOT TOKEN
const DISCORD_TOKEN = const DISCORD_TOKEN = process.env.DISCORD_TOKEN || 'MTQ4NTM3NTkxMDU2Mjc1ODk2Nw.Gx1TFk.1nips1DURrV3d80Y0lMOAS7MYORdzrdnW60rU0';

const PORT = 5555;
const DB_FOLDER = path.join(__dirname, 'database');

const EMAIL_USER = 'fusionhub122@gmail.com'; 
const EMAIL_PASS = 'bjes fepg nqqf aioq';    

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: EMAIL_USER, pass: EMAIL_PASS }
});

if (!fs.existsSync(DB_FOLDER)) fs.mkdirSync(DB_FOLDER);
const dbFiles = {
    users: path.join(DB_FOLDER, 'users.json'),
    otps: path.join(DB_FOLDER, 'otps.json'),
    resets: path.join(DB_FOLDER, 'resets.json'),
    liked: path.join(DB_FOLDER, 'liked.json'),
    playlists: path.join(DB_FOLDER, 'playlists.json'),
    reactRoles: path.join(DB_FOLDER, 'react_roles.json'),
    economy: path.join(DB_FOLDER, 'economy.json'),
    daily: path.join(DB_FOLDER, 'daily.json')
};
for (const key in dbFiles) { if (!fs.existsSync(dbFiles[key])) fs.writeFileSync(dbFiles[key], '{}'); }

function readDB(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function writeDB(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }
function parseBody(req) {
    return new Promise((resolve) => {
        let body = ''; req.on('data', chunk => body += chunk);
        req.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve({}); } });
    });
}

// ==========================================
// 2. ECONOMY, LUCK (0-1000) & LEVEL ENGINE
// ==========================================
function getUser(id) {
    const db = readDB(dbFiles.economy);
    if (!db[id] || typeof db[id] === 'number') { 
        db[id] = { bal: db[id] || 0, luck: 0, prayTime: 0, xp: 0, level: 1, lastMsg: 0, hunts: 0 }; 
        writeDB(dbFiles.economy, db); 
    }
    if (db[id].xp === undefined) db[id].xp = 0;
    if (db[id].level === undefined) db[id].level = 1;
    if (db[id].luck === undefined) db[id].luck = 0;
    if (db[id].hunts === undefined) db[id].hunts = 0;
    return db[id];
}
function saveUser(id, data) {
    const db = readDB(dbFiles.economy);
    db[id] = data; writeDB(dbFiles.economy, db);
}
function getBal(id) { return getUser(id).bal; }
function addBal(id, amt) {
    let u = getUser(id); u.bal += amt; saveUser(id, u);
}

// LEVEL UP ALGORITHM (Hard Scaling)
function addXp(ctx, id, amount) {
    let u = getUser(id);
    u.xp += amount;
    const reqXp = u.level * u.level * 150; // Gets progressively much harder
    if (u.xp >= reqXp) {
        u.level++;
        const reward = u.level * 1000;
        u.bal += reward;
        
        const lvlEmbed = new EmbedBuilder()
            .setColor('#00ff00')
            .setAuthor({ name: 'FUSION LEVEL UP', iconURL: 'https://cdn-icons-png.flaticon.com/512/4113/4113009.png' })
            .setTitle(`🎊 Congratulations <@${id}>! 🎊`)
            .setDescription(`You just reached **Level ${u.level}**!\n\n🎁 **Gift:** \`$${reward}\` TPG Coins!`)
            .setThumbnail('https://cdn-icons-png.flaticon.com/512/4113/4113009.png');
            
        ctx.channelSend({ content: `<@${id}>`, embeds: [lvlEmbed] });
    }
    saveUser(id, u);
}

// ==========================================
// 3. ANTI-DDOS & SPAM PROTECTION
// ==========================================
const rateLimits = new Map();
const DISCORD_COOLDOWNS = new Map();

function isRateLimited(ip) {
    const now = Date.now();
    if (!rateLimits.has(ip)) { rateLimits.set(ip, { count: 1, lastReset: now }); return false; }
    const data = rateLimits.get(ip);
    if (now - data.lastReset > 10000) { data.count = 1; data.lastReset = now; return false; }
    data.count++; return data.count > 40; 
}
function isDiscordSpamming(userId) {
    const now = Date.now();
    if (!DISCORD_COOLDOWNS.has(userId)) { DISCORD_COOLDOWNS.set(userId, now); return false; }
    if (now - DISCORD_COOLDOWNS.get(userId) < 1200) return true;
    DISCORD_COOLDOWNS.set(userId, now); return false;
}

// ==========================================
// 4. MUSIC STREAMING ENGINE (FAST SEARCH)
// ==========================================
const memCache = { search: {} }; 
let globalRecommendsCache = [];

function findYtDlp() {
  const c = ['/data/data/com.termux/files/usr/bin/yt-dlp', '/usr/bin/yt-dlp'];
  for (const p of c) if (fs.existsSync(p)) return p;
  try { return execSync('which yt-dlp').toString().trim(); } catch {} return 'yt-dlp';
}
const YTDLP_PATH = findYtDlp();

function ytRun(args) {
  return new Promise((resolve) => {
    const proc = spawn(YTDLP_PATH, args);
    let out = ''; proc.stdout.on('data', d => out += d);
    proc.on('close', () => resolve(out.trim()));
  });
}

// Optimized Search Command
async function searchYouTube(query, limit = 15) {
  if (memCache.search[query]) return memCache.search[query].data;
  const out = await ytRun(['--print', '%(id)s|||%(title)s|||%(uploader)s|||%(thumbnail)s|||%(duration)s', '--no-warnings', '--flat-playlist', `ytsearch${limit}:${query}`]);
  const results = out.split('\n').filter(Boolean).map(line => {
    let [id, title, artist, thumbnail, duration] = line.split('|||');
    if (thumbnail && thumbnail.includes('mqdefault.jpg')) { thumbnail = thumbnail.replace('mqdefault.jpg', 'maxresdefault.jpg'); }
    return { id, title: title || 'Unknown', artist: artist || 'Unknown', thumbnail: thumbnail && thumbnail !== 'NA' ? thumbnail : `https://i.ytimg.com/vi/${id}/mqdefault.jpg`, duration: parseInt(duration) || 0 };
  }).filter(s => s.id && s.id.length > 3);
  memCache.search[query] = { data: results, time: Date.now() };
  return results;
}

function primeCache() { 
    searchYouTube('latest global pop hits 2024', 50).then(r => { if(r && r.length > 0) globalRecommendsCache = r; }); 
}
primeCache();

function shuffleArray(array) {
    let shuffled = array.slice();
    for (let i = shuffled.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]; }
    return shuffled;
}

async function getSongInfo(videoId) {
  const out = await ytRun(['--print', '%(id)s|||%(title)s|||%(uploader)s|||%(thumbnail)s|||%(duration)s', '--no-warnings', `https://www.youtube.com/watch?v=${videoId}`]);
  const parts = out.split('\n')[0].split('|||');
  if(parts.length >= 5) {
    let thumbnail = parts[3];
    if (thumbnail && thumbnail.includes('mqdefault.jpg')) { thumbnail = thumbnail.replace('mqdefault.jpg', 'maxresdefault.jpg'); }
    return { id: parts[0], title: parts[1], artist: parts[2], thumbnail: thumbnail, duration: parseInt(parts[4]) };
  }
  return null;
}

async function getStreamUrl(videoId) {
  const out = await ytRun(['-f', 'bestaudio[ext=m4a]/bestaudio', '--get-url', '--no-playlist', '--no-warnings', `https://www.youtube.com/watch?v=${videoId}`]);
  const url = out.split('\n').find(line => line.startsWith('http'));
  return url || null;
}

function fetchLyricsApi(title, artist) {
    return new Promise((resolve) => {
        const cleanT = (title || '').replace(/\[.*?\]/g, '').replace(/\(.*?\)/g, '').replace(/ - Topic$/, '').trim();
        const cleanA = (artist || '').replace(/ - Topic$/, '').trim();
        const searchQuery = encodeURIComponent(`${cleanT} ${cleanA}`.trim());
        https.get({ hostname: 'lrclib.net', path: `/api/search?q=${searchQuery}`, method: 'GET', headers: { 'User-Agent': 'FusionMusic-App/5.0' } }, (res) => {
            let data = ''; res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { const results = JSON.parse(data); if (results && results.length > 0) resolve(results[0]); else resolve({ error: "No lyrics available." }); } catch(e) { resolve({ error: "No lyrics available." }); }
            });
        });
    });
}

// ==========================================
// 5. DISCORD BOT ENGINE
// ==========================================
const discordClient = new Client({ 
    intents: [
        GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, 
        GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessageReactions 
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});

const serverQueues = new Map();
const tttGames = new Map(); 

function createTTTBoard(board, disabled = false) {
    const rows = [];
    for (let i = 0; i < 3; i++) {
        const row = new ActionRowBuilder();
        for (let j = 0; j < 3; j++) {
            const index = i * 3 + j;
            const mark = board[index];
            let style = ButtonStyle.Secondary;
            if (mark === '❌') style = ButtonStyle.Danger;
            else if (mark === '⭕') style = ButtonStyle.Primary;
            row.addComponents(new ButtonBuilder().setCustomId(`ttt_${index}`).setLabel(mark).setStyle(style).setDisabled(disabled || mark !== '⬜'));
        }
        rows.push(row);
    }
    return rows;
}

discordClient.on('ready', async () => { 
    console.log(`\n🤖 TPG MASTER BOT ONLINE: ${discordClient.user.tag}\n`); 
    try {
        const cmds = [
            { name: 'play', description: 'Play music', options: [{ name: 'song', type: 3, description: 'Song name', required: true }] },
            { name: 'skip', description: 'Skip current song' },
            { name: 'pause', description: 'Pause music' },
            { name: 'resume', description: 'Resume music' },
            { name: 'stop', description: 'Stop music' },
            { name: 'leave', description: 'Leave voice channel' },
            { name: 'queue', description: 'View current playlist' },
            { name: 'loop', description: 'Toggle loop mode' },
            { name: 'shuffle', description: 'Shuffle queue' },
            { name: 'clear', description: 'Clear queue' },
            { name: 'ping', description: 'Check bot latency' },
            { name: 'daily', description: 'Claim daily reward' },
            { name: 'bal', description: 'Check balance' },
            { name: 'level', description: 'Check Level, XP, and Rank' },
            { name: 'pray', description: 'Pray for +1 luck point' },
            { name: 'hunt', description: 'Hunt for animals' },
            { name: 'cf', description: 'Coinflip bet', options: [{ name: 'amount', type: 3, description: 'Bet amount or "all"', required: true }, { name: 'side', type: 3, description: 'h or t (Defaults to h)', required: false }] },
            { name: 'slots', description: 'Slot machine', options: [{ name: 'amount', type: 3, description: 'Bet amount or "all"', required: true }] },
            { name: 'give', description: 'Transfer coins', options: [{ name: 'user', type: 6, description: 'User to give to', required: true }, { name: 'amount', type: 3, description: 'Amount or "all"', required: true }] },
            { name: 'ttt', description: 'Tic-Tac-Toe', options: [{ name: 'user', type: 6, description: 'Opponent', required: true }, { name: 'bet', type: 4, description: 'Bet amount', required: false }] },
            { name: 'lb', description: 'View the richest players (Money, Level, Luck, Hunts)' },
            { name: 'leaderboard', description: 'View the richest players' },
            { name: 'timeout', description: 'Timeout a user', options: [{ name: 'user', type: 6, description: 'User to timeout', required: true }, { name: 'minutes', type: 4, description: 'Duration in mins', required: true }] },
            { name: 'ban', description: 'Ban a user', options: [{ name: 'user', type: 6, description: 'User to ban', required: true }] },
            { name: 'kick', description: 'Kick a user', options: [{ name: 'user', type: 6, description: 'User to kick', required: true }] },
            { name: 'help', description: 'Show all commands' }
        ];
        await discordClient.application.commands.set(cmds);
    } catch(e) {}
});

discordClient.on('interactionCreate', async interaction => {
    if (interaction.isButton() && interaction.customId.startsWith('ttt_')) {
        const game = tttGames.get(interaction.channelId);
        if (!game) return interaction.reply({ content: 'Game has ended.', ephemeral: true });
        if (interaction.user.id !== game.turn) return interaction.reply({ content: 'Not your turn!', ephemeral: true });
        const move = parseInt(interaction.customId.split('_')[1]);
        if (game.board[move] !== '⬜') return interaction.reply({ content: 'Spot taken!', ephemeral: true });

        game.board[move] = (interaction.user.id === game.p1) ? '❌' : '⭕';
        const wins = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
        let won = wins.some(p => game.board[p[0]] !== '⬜' && game.board[p[0]] === game.board[p[1]] && game.board[p[1]] === game.board[p[2]]);
        
        if (won) {
            addBal(interaction.user.id, game.bet); addBal(interaction.user.id === game.p1 ? game.p2 : game.p1, -game.bet);
            tttGames.delete(interaction.channelId);
            await interaction.update({ content: `🏆 **${interaction.user.username} WON!** (+$${game.bet})`, components: createTTTBoard(game.board, true) });
        } else if (!game.board.includes('⬜')) {
            tttGames.delete(interaction.channelId);
            await interaction.update({ content: `🤝 **Draw!** No coins lost.`, components: createTTTBoard(game.board, true) });
        } else {
            game.turn = (game.turn === game.p1) ? game.p2 : game.p1;
            await interaction.update({ content: `🎮 **Tic-Tac-Toe**\n<@${game.p1}> vs <@${game.p2}>\nBet: **$${game.bet}**\n\n<@${game.turn}>'s move!`, components: createTTTBoard(game.board) });
        }
        return;
    }

    if (interaction.isButton()) {
        const queue = serverQueues.get(interaction.guildId);
        if (!queue) return interaction.reply({ content: 'Queue is empty.', ephemeral: true });

        if (interaction.customId === 'btn_prev') {
            if (queue.history.length > 0) {
                const prevSong = queue.history.pop();
                queue.songs.unshift(prevSong); 
                queue.skippingToPrev = true;
                queue.player.stop(); 
                await interaction.reply({ content: '⏮️ Playing previous...', ephemeral: true });
            } else { await interaction.reply({ content: '❌ No previous song.', ephemeral: true }); }
        }
        else if (interaction.customId === 'btn_pause') {
            if (queue.playing) { queue.player.pause(); queue.playing = false; await interaction.reply({ content: '⏸️ Paused', ephemeral: true }); }
            else { queue.player.unpause(); queue.playing = true; await interaction.reply({ content: '▶️ Resumed', ephemeral: true }); }
        } 
        else if (interaction.customId === 'btn_skip') {
            queue.player.stop(); await interaction.reply({ content: '⏭️ Skipped', ephemeral: true });
        } 
        else if (interaction.customId === 'btn_stop') {
            queue.songs = []; queue.player.stop(); await interaction.reply({ content: '⏹️ Stopped', ephemeral: true });
        } 
        else if (interaction.customId === 'btn_leave') {
            queue.songs = []; queue.history = []; queue.player.stop();
            if (queue.connection) queue.connection.destroy();
            serverQueues.delete(interaction.guildId);
            await interaction.reply({ content: '🚪 Left Voice.', ephemeral: true });
        }
        else if (interaction.customId === 'btn_voldown') {
            queue.volume = Math.max(0.1, queue.volume - 0.2);
            if(queue.resource) queue.resource.volume.setVolume(queue.volume);
            await interaction.reply({ content: `🔉 Volume lowered.`, ephemeral: true });
        }
        else if (interaction.customId === 'btn_volup') {
            queue.volume = Math.min(2.0, queue.volume + 0.2);
            if(queue.resource) queue.resource.volume.setVolume(queue.volume);
            await interaction.reply({ content: `🔊 Volume raised.`, ephemeral: true });
        }
        else if (interaction.customId === 'btn_loop') {
            queue.loop = (queue.loop + 1) % 3; const modes = ['Off', 'Queue', 'Track'];
            await interaction.reply({ content: `🔁 Loop mode is now **${modes[queue.loop]}**`, ephemeral: true });
        } 
        else if (interaction.customId === 'btn_shuffle') {
            if (queue.songs.length > 2) {
                const first = queue.songs.shift(); queue.songs = shuffleArray(queue.songs); queue.songs.unshift(first);
                await interaction.reply({ content: '🔀 Queue shuffled!', ephemeral: true });
            } else await interaction.reply({ content: 'Not enough songs.', ephemeral: true });
        }
        else if (interaction.customId === 'btn_queue') {
            let qStr = queue.songs.map((s, i) => `${i === 0 ? '**[Playing]**' : `**${i}.**`} ${s.title}`).slice(0, 10).join('\n');
            await interaction.reply({ content: `🎶 **Playlist:**\n${qStr}`, ephemeral: true });
        }
        else if (interaction.customId === 'btn_clear') {
            if(queue.songs.length > 1) queue.songs = [queue.songs[0]];
            await interaction.reply({ content: '🗑️ Queue cleared.', ephemeral: true });
        }
        return;
    }

    if (interaction.isChatInputCommand()) {
        try {
            await interaction.deferReply(); 
            const cmd = interaction.commandName;
            let args = [];
            
            if (cmd === 'play') args.push(...(interaction.options.getString('song') || '').split(' '));
            if (cmd === 'cf') { args.push(interaction.options.getString('amount')); args.push(interaction.options.getString('side') || 'h'); }
            if (cmd === 'slots') args.push(interaction.options.getString('amount'));
            if (cmd === 'give') { args.push("dummy_user"); args.push(interaction.options.getString('amount')); }
            if (cmd === 'ttt') { args.push("dummy_user"); const bet = interaction.options.getInteger('bet'); if (bet) args.push(bet.toString()); }
            if (cmd === 'timeout') { args.push("dummy_user"); args.push(interaction.options.getString('minutes')); }

            const ctx = {
                isSlash: true,
                author: interaction.user, member: interaction.member, guild: interaction.guild, channel: interaction.channel,
                mentions: { users: { first: () => interaction.options.getUser('user') }, members: { first: () => interaction.options.getMember('user') }, roles: { first: () => null } },
                reply: async (c) => interaction.editReply(c),
                channelSend: async (c) => interaction.channel.send(c)
            };

            if (isDiscordSpamming(ctx.author.id)) return ctx.reply({content: '✋ Cooldown! Slow down.'});
            await executeCommand(ctx, cmd, args, interaction);
        } catch (e) { console.log(e); }
    }
});

// REACTION ROLE HANDLERS
discordClient.on('messageReactionAdd', async (reaction, user) => {
    if (user.bot) return;
    if (reaction.partial) try { await reaction.fetch(); } catch(e) { return; }
    const rrDb = readDB(dbFiles.reactRoles);
    const roleData = rrDb[reaction.message.id];
    if (roleData && (reaction.emoji.name === roleData.emoji || reaction.emoji.toString() === roleData.emoji)) {
        const member = await reaction.message.guild.members.fetch(user.id);
        if (member) member.roles.add(roleData.roleId).catch(()=>{});
    }
});

discordClient.on('messageReactionRemove', async (reaction, user) => {
    if (user.bot) return;
    if (reaction.partial) try { await reaction.fetch(); } catch(e) { return; }
    const rrDb = readDB(dbFiles.reactRoles);
    const roleData = rrDb[reaction.message.id];
    if (roleData && (reaction.emoji.name === roleData.emoji || reaction.emoji.toString() === roleData.emoji)) {
        const member = await reaction.message.guild.members.fetch(user.id);
        if (member) member.roles.remove(roleData.roleId).catch(()=>{});
    }
});

discordClient.on('messageCreate', async message => {
    if (message.author.bot) return;

    let uData = getUser(message.author.id);
    const now = Date.now();
    if (now - uData.lastMsg > 60000) {
        uData.lastMsg = now; saveUser(message.author.id, uData);
        const passiveCtx = { channelSend: async (c) => message.channel.send(c) };
        addXp(passiveCtx, message.author.id, Math.floor(Math.random() * 3) + 1);
    }

    let content = message.content.trim();
    let contentLower = content.toLowerCase();
    const mentionPrefix = `<@${discordClient.user.id}>`;
    const mentionPrefixNick = `<@!${discordClient.user.id}>`;

    let isCmd = false; let prefixLen = 0;

    if (contentLower.startsWith('/')) { isCmd = true; prefixLen = 1; }
    else if (contentLower.startsWith('!')) { isCmd = true; prefixLen = 1; }
    else if (contentLower.startsWith('tpg ')) { isCmd = true; prefixLen = 4; }
    else if (contentLower.startsWith('@tpg ')) { isCmd = true; prefixLen = 5; }
    else if (content.startsWith(mentionPrefix)) { isCmd = true; prefixLen = mentionPrefix.length; }
    else if (content.startsWith(mentionPrefixNick)) { isCmd = true; prefixLen = mentionPrefixNick.length; }

    const game = tttGames.get(message.channel.id);
    if (game && message.author.id === game.turn && /^[1-9]$/.test(content)) {
        const move = parseInt(content) - 1;
        if (game.board[move] === '⬜') {
            game.board[move] = (message.author.id === game.p1) ? '❌' : '⭕';
            const wins = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
            let won = wins.some(p => game.board[p[0]] !== '⬜' && game.board[p[0]] === game.board[p[1]] && game.board[p[1]] === game.board[p[2]]);
            const b = game.board;
            const boardRender = `${b[0]}${b[1]}${b[2]}\n${b[3]}${b[4]}${b[5]}\n${b[6]}${b[7]}${b[8]}`;
            
            if (won) {
                addBal(message.author.id, game.bet); addBal(message.author.id === game.p1 ? game.p2 : game.p1, -game.bet);
                message.channel.send(`🏆 **${message.author.username} WON!** and took the **$${game.bet}** bet!\n\n${boardRender}`);
                tttGames.delete(message.channel.id);
            } else if (!game.board.includes('⬜')) {
                message.channel.send(`🤝 **Draw!** No coins lost.\n\n${boardRender}`); tttGames.delete(message.channel.id);
            } else {
                game.turn = (game.turn === game.p1) ? game.p2 : game.p1;
                message.channel.send(`${boardRender}\n\n<@${game.turn}>, your move! (1-9)`);
            }
            return;
        }
    }

    if (!isCmd) return;
    if (isDiscordSpamming(message.author.id)) return message.reply('✋ Cooldown! Slow down a bit.').then(m => setTimeout(()=>m.delete().catch(()=>{}), 3000));

    content = content.slice(prefixLen).trim();
    if (content.toLowerCase().startsWith('tpg ')) content = content.slice(4).trim(); 

    const args = content.split(/ +/);
    const command = args.shift().toLowerCase();

    const ctx = {
        isSlash: false,
        author: message.author, member: message.member, guild: message.guild, channel: message.channel,
        mentions: message.mentions,
        reply: async (c) => message.reply(c),
        channelSend: async (c) => message.channel.send(c)
    };

    await executeCommand(ctx, command, args, message);
});

// ==========================================
// UNIFIED COMMAND LOGIC
// ==========================================
async function executeCommand(ctx, command, args, rawMessage) {
    if (command === 'ping') {
        return ctx.reply(`🏓 Pong! Bot latency is **${discordClient.ws.ping}ms**.`);
    }
    
    // Slash command exclusive leaderboard
    else if (['lb', 'leaderboard'].includes(command)) {
        if (!ctx.isSlash) return ctx.reply('❌ The Leaderboard command is exclusively available via the `/lb` slash command!');
        const db = readDB(dbFiles.economy);
        const sorted = Object.entries(db)
            .map(([id, data]) => ({ id, ...data }))
            .sort((a, b) => b.bal - a.bal)
            .slice(0, 10);
        
        let lbText = sorted.map((user, i) => `**${i+1}.** <@${user.id}> - 💰 **$${user.bal}** | ⭐ Lvl **${user.level}** | 🍀 Luck **${user.luck}** | 🏹 Hunts **${user.hunts || 0}**`).join('\n\n');
        if(!lbText) lbText = "No players yet!";
        const embed = new EmbedBuilder().setColor('#fc3c44').setAuthor({ name: '🏆 FUSION MUSIC LEADERBOARD' }).setDescription(lbText);
        return ctx.reply({ embeds: [embed] });
    }

    else if (command === 'pray') {
        let u = getUser(ctx.author.id);
        const now = Date.now();
        if (now - u.prayTime < 600000) { 
            const mins = Math.ceil((600000 - (now - u.prayTime))/60000);
            return ctx.reply(`🙏 The gods are resting. Pray again in **${mins} minutes**.`);
        }
        u.prayTime = now; 
        u.luck = Math.min(1000, u.luck + 1); 
        saveUser(ctx.author.id, u);
        addXp(ctx, ctx.author.id, 5);
        return ctx.reply(`🙏 | <@${ctx.author.id}> prays... Luck is on your side!\n**| You have ${u.luck} luck point(s)!**`);
    }

    else if (['level', 'lvl', 'profile'].includes(command)) {
        let u = getUser(ctx.author.id);
        const reqXp = u.level * u.level * 150;
        
        // Find Rank
        const db = readDB(dbFiles.economy);
        const sorted = Object.entries(db).map(([id, data]) => ({ id, ...data })).sort((a, b) => b.xp - a.xp);
        const rank = sorted.findIndex(user => user.id === ctx.author.id) + 1;

        // Visual Progress Bar
        const totalBars = 15;
        const progress = Math.min(1, u.xp / reqXp);
        const filled = Math.floor(progress * totalBars);
        const empty = totalBars - filled;
        const progressBar = `[${'█'.repeat(filled)}${' '.repeat(empty)}]`;

        const embed = new EmbedBuilder()
            .setColor('#2b2d31')
            .setAuthor({ name: ctx.author.username, iconURL: ctx.author.displayAvatarURL() || 'https://cdn-icons-png.flaticon.com/512/1077/1077012.png' })
            .setDescription(`A FUSION MUSIC User\n\n**LVL ${u.level}**\n**Rank:** #${rank} | **XP:** ${u.xp}/${reqXp}\n\`${progressBar}\``)
            .setThumbnail(ctx.author.displayAvatarURL() || 'https://cdn-icons-png.flaticon.com/512/1077/1077012.png');
        return ctx.reply({ embeds: [embed] });
    }

    else if (command === 'daily') {
        const dailyDb = readDB(dbFiles.daily);
        const last = dailyDb[ctx.author.id] || 0;
        const now = Date.now();
        if (now - last < 86400000) {
            const rem = 86400000 - (now - last);
            return ctx.reply(`⏰ Come back in **${Math.floor(rem/3600000)} hours** for your reward!`);
        }
        const reward = 250 + Math.floor(Math.random() * 550); 
        addBal(ctx.author.id, reward);
        dailyDb[ctx.author.id] = now; writeDB(dbFiles.daily, dailyDb);
        return ctx.reply(`🎁 **Daily Reward!** You received **$${reward}** TPG coins!`);
    }

    else if (['bal', 'balance', 'cash'].includes(command)) {
        return ctx.reply(`💰 **${ctx.author.username}'s Wallet:** \`$${getBal(ctx.author.id)}\``);
    }

    else if (['cf', 'coinflip'].includes(command)) {
        let betStr, choice;
        if (args.length > 0 && ['h', 't', 'heads', 'tails'].includes(args[0].toLowerCase())) {
            choice = args[0].toLowerCase()[0]; betStr = args[1];
        } else {
            betStr = args[0]; choice = (args[1] ? args[1].toLowerCase()[0] : null);
            if (!['h', 't'].includes(choice)) choice = 'h'; 
        }

        if (!betStr) return ctx.reply('❌ Usage: `cf <all/amount> [h/t]`');
        
        let u = getUser(ctx.author.id);
        let bet = betStr.toLowerCase() === 'all' ? Math.min(u.bal, 250000) : parseInt(betStr);
        if (isNaN(bet) || bet <= 0) return ctx.reply('❌ Invalid amount!');
        if (u.bal < bet) return ctx.reply('❌ Not enough money!');

        let luckBonus = (u.luck / (u.luck + 100)) * 0.40; 
        let winChance = 0.50 + luckBonus;
        
        const win = Math.random() < winChance;
        const result = win ? choice : (choice === 'h' ? 't' : 'h');
        
        addXp(ctx, ctx.author.id, Math.floor(Math.random() * 15) + 10); 

        const cfGif = 'https://media.tenor.com/2Xy-_1E3u5gAAAAi/coin-flip-flip.gif';
        const animEmbed = new EmbedBuilder().setColor('#fc3c44').setImage(cfGif).setDescription(`**Flipping a coin for $${bet}...**`);
        let msg = await ctx.reply({ embeds: [animEmbed] });
        
        setTimeout(() => {
            const resText = win ? `🎉 You won **$${bet}**!` : `💀 You lost **$${bet}**.`;
            const color = win ? '#00ff00' : '#ff0000';
            const resEmbed = new EmbedBuilder().setColor(color)
                .setThumbnail('https://cdn-icons-png.flaticon.com/512/888/888941.png')
                .setDescription(`🪙 It landed on **${result === 'h' ? 'Heads' : 'Tails'}**!\n\n${resText}`);
            
            if (win) addBal(ctx.author.id, bet); else addBal(ctx.author.id, -bet);
            if(msg.edit) msg.edit({ embeds: [resEmbed] }); 
            else if(msg.editReply) msg.editReply({ embeds: [resEmbed] }); 
            else ctx.reply({ embeds: [resEmbed] });
        }, 1600); // Set EXACTLY to 1.6 seconds
    }

    else if (['slots', 's'].includes(command)) {
        let betStr = args[0];
        if (!betStr) return ctx.reply('❌ Usage: `slots <all/amount>`');
        
        let u = getUser(ctx.author.id);
        let bet = betStr.toLowerCase() === 'all' ? Math.min(u.bal, 250000) : parseInt(betStr);
        if (isNaN(bet) || bet <= 0) return ctx.reply('❌ Invalid amount!');
        if (u.bal < bet) return ctx.reply('❌ Not enough money!');

        let luckBonus = (u.luck / (u.luck + 100)); 
        addXp(ctx, ctx.author.id, Math.floor(Math.random() * 15) + 10);

        const slotGif = 'https://media.tenor.com/uG_jFz5OomkAAAAi/slot-machine-casino.gif';
        const animEmbed = new EmbedBuilder().setColor('#fc3c44').setImage(slotGif).setDescription(`**Spinning the slots for $${bet}...**`);
        let msg = await ctx.reply({ embeds: [animEmbed] });

        setTimeout(() => {
            const items = ['💎', '💰', '👑', '🔥', '🌟']; 
            let a = items[Math.floor(Math.random() * items.length)];
            let b = items[Math.floor(Math.random() * items.length)];
            let c = items[Math.floor(Math.random() * items.length)];
            
            if (Math.random() < 0.15) b = a; 
            if (Math.random() < (0.20 * luckBonus)) { b = a; c = a; } 
            
            let resText = ""; let color = "#fc3c44";
            if (a === b && b === c) { addBal(ctx.author.id, bet * 10); color = '#00ff00'; resText = `🎰 **JACKPOT!** Won **$${bet * 10}**!`; } 
            else { addBal(ctx.author.id, -bet); color = '#ff0000'; resText = `💀 **Lose!** Lost **$${bet}**.`; }

            const resEmbed = new EmbedBuilder().setColor(color).setDescription(`**[ ${a} | ${b} | ${c} ]**\n\n${resText}`);
            if(msg.edit) msg.edit({ embeds: [resEmbed] }); else if(msg.editReply) msg.editReply({ embeds: [resEmbed] }); else ctx.reply({ embeds: [resEmbed] });
        }, 2500); // Set EXACTLY to 2.5 seconds
    }

    else if (['hunt', 'h'].includes(command)) {
        let u = getUser(ctx.author.id);
        if (u.bal < 100) return ctx.reply('❌ You need **$100** to buy hunting gear!');
        u.bal -= 100;
        
        let luckBonus = (u.luck / (u.luck + 100));
        addXp(ctx, ctx.author.id, 10);
        
        let msg = await ctx.reply(`🌲 🏹 Searching the forest...`);

        setTimeout(() => {
            const animals = ['🦌', '🐗', '🐍', '🐘', '🐅', '🦆', '🐁'];
            const caught = animals[Math.floor(Math.random() * animals.length)];
            let min = 20, max = 150;
            if (Math.random() < luckBonus) { min = 100; max = 350; } 
            const val = min + Math.floor(Math.random() * (max - min));
            
            u.bal += val;
            u.hunts = (u.hunts || 0) + 1; // Increment Hunt Stat
            saveUser(ctx.author.id, u);

            const res = `🏹 Caught a **${caught}**! Sold for **$${val}**! (Profit: $${val - 100})`;
            if(msg.edit) msg.edit(res); else if(msg.editReply) msg.editReply(res); else ctx.reply(res);
        }, 1000); // Set EXACTLY to 1 second
    }

    else if (['give', 'transfer'].includes(command)) {
        const target = ctx.mentions.users.first() || (ctx.guild ? ctx.guild.members.cache.get(args[0])?.user : null);
        const amtStr = args[args.length - 1];
        if (!target || !amtStr) return ctx.reply('❌ Usage: `give @user <all/amount>`');
        
        let u = getUser(ctx.author.id);
        let amt = amtStr.toLowerCase() === 'all' ? u.bal : parseInt(amtStr);
        if (isNaN(amt) || amt <= 0 || u.bal < amt) return ctx.reply('❌ Invalid amount or insufficient funds.');
        
        addBal(ctx.author.id, -amt); addBal(target.id, amt);
        return ctx.reply(`💸 Sent **$${amt}** to ${target.username}!`);
    }

    else if (command === 'ttt') {
        const opponent = ctx.mentions.users.first() || (ctx.guild ? ctx.guild.members.cache.get(args[0])?.user : null);
        const betStr = args[1];
        if (!opponent || opponent.bot || opponent.id === ctx.author.id) return ctx.reply('❌ Mention a valid opponent.');
        
        let u = getUser(ctx.author.id);
        let bet = betStr?.toLowerCase() === 'all' ? Math.min(u.bal, 250000) : (parseInt(betStr) || 0);
        if (u.bal < bet || getBal(opponent.id) < bet) return ctx.reply('❌ One of you is too poor for this bet!');

        const board = ['⬜','⬜','⬜','⬜','⬜','⬜','⬜','⬜','⬜'];
        const components = createTTTBoard(board);
        
        tttGames.set(ctx.channel.id, { p1: ctx.author.id, p2: opponent.id, bet, board, turn: ctx.author.id });
        return ctx.reply({ content: `🎮 **Tic-Tac-Toe**\n<@${ctx.author.id}> vs <@${opponent.id}>\nBet: **$${bet}**\n\n<@${ctx.author.id}>, your move!`, components });
    }

    // --- MUSIC ---
    else if (['play', 'p'].includes(command)) {
        const voiceChannel = ctx.member?.voice?.channel;
        if (!voiceChannel) return ctx.reply('❌ Join a voice channel first!');
        
        try {
            const permissions = voiceChannel.permissionsFor(discordClient.user);
            if (!permissions.has('Connect') || !permissions.has('Speak')) {
                return ctx.reply('❌ I need **Connect** and **Speak** permissions in this voice channel!');
            }
        } catch(e) {}

        const query = args.join(' ');
        if (!query) return ctx.reply('❌ What should I play?');

        let searchMsg = await ctx.reply(`🔍 Searching for **${query}**...`);
        const results = await searchYouTube(query, 1);
        
        if (!results || !results.length) {
            if (searchMsg.edit) return searchMsg.edit('❌ No results found or search timed out.');
            else if (searchMsg.editReply) return searchMsg.editReply('❌ No results found or search timed out.');
            else return ctx.channelSend('❌ No results found or search timed out.');
        }
        const song = results[0];

        let queue = serverQueues.get(ctx.guild.id);
        if (!queue) {
            queue = { textChannel: ctx.channel, voiceChannel, connection: null, player: createAudioPlayer(), songs: [], history: [], skippingToPrev: false, loop: 0, playing: true, volume: 1.0 };
            serverQueues.set(ctx.guild.id, queue);
            queue.songs.push(song);
            try {
                const conn = joinVoiceChannel({ channelId: voiceChannel.id, guildId: ctx.guild.id, adapterCreator: ctx.guild.voiceAdapterCreator });
                
                conn.on('error', err => console.error("Voice Connection Error:", err));
                
                queue.connection = conn; conn.subscribe(queue.player);
                
                queue.player.on(AudioPlayerStatus.Idle, () => { 
                    const q = serverQueues.get(ctx.guild.id);
                    if(!q) return;
                    
                    if (q.skippingToPrev) {
                        q.skippingToPrev = false; 
                    } else {
                        const lastSong = q.songs.shift();
                        if (q.loop === 2) {
                            q.songs.unshift(lastSong); 
                        } else if (q.loop === 1) {
                            if (lastSong) q.history.push(lastSong);
                            if (lastSong) q.songs.push(lastSong); 
                        } else {
                            if (lastSong) q.history.push(lastSong); 
                        }
                    }
                    playDiscordSong(ctx.guild.id, q.songs[0]); 
                });

                queue.player.on('error', err => {
                    const q = serverQueues.get(ctx.guild.id);
                    if(q) { q.songs.shift(); playDiscordSong(ctx.guild.id, q.songs[0]); }
                });
                
                if(searchMsg.edit) searchMsg.edit(`✅ Found **${song.title}**! Starting playback...`);
                else if(searchMsg.editReply) searchMsg.editReply(`✅ Found **${song.title}**! Starting playback...`);
                
                playDiscordSong(ctx.guild.id, queue.songs[0]);
            } catch (e) { 
                serverQueues.delete(ctx.guild.id); 
                return ctx.channelSend(`❌ **Voice Join Error:** ${e.message}`); 
            }
        } else {
            queue.songs.push(song); 
            if(searchMsg.edit) return searchMsg.edit(`✅ Added **${song.title}** to queue.`);
            else if(searchMsg.editReply) return searchMsg.editReply(`✅ Added **${song.title}** to queue.`);
            else return ctx.channelSend(`✅ Added **${song.title}** to queue.`);
        }
    }
    else if (['skip', 'next', 's'].includes(command) && command !== 'slots') {
        const queue = serverQueues.get(ctx.guild.id);
        if (!queue) return ctx.reply('❌ Nothing is playing!');
        queue.player.stop(); ctx.reply('⏭️ Skipped!');
    }
    else if (['pause'].includes(command)) {
        const queue = serverQueues.get(ctx.guild.id);
        if (!queue || !queue.playing) return ctx.reply('❌ Nothing is playing!');
        queue.player.pause(); queue.playing = false; ctx.reply('⏸️ Paused!');
    }
    else if (['resume'].includes(command)) {
        const queue = serverQueues.get(ctx.guild.id);
        if (!queue || queue.playing) return ctx.reply('❌ Music is already playing!');
        queue.player.unpause(); queue.playing = true; ctx.reply('▶️ Resumed!');
    }
    else if (['stop', 'leave', 'disconnect'].includes(command)) {
        const queue = serverQueues.get(ctx.guild.id);
        if (!queue) return ctx.reply('❌ Nothing is playing!');
        queue.songs = []; queue.history = []; queue.player.stop(); 
        if (queue.connection) queue.connection.destroy();
        serverQueues.delete(ctx.guild.id); ctx.reply('⏹️ Stopped the music and left the channel.');
    }
    else if (['loop', 'l'].includes(command) && command !== 'level' && command !== 'luck' && command !== 'lb') {
        const queue = serverQueues.get(ctx.guild.id);
        if (!queue) return ctx.reply('❌ Nothing is playing!');
        queue.loop = (queue.loop + 1) % 3; const modes = ['Off', 'Queue', 'Track'];
        ctx.reply(`🔁 Loop mode set to: **${modes[queue.loop]}**`);
    }
    else if (command === 'shuffle') {
        const queue = serverQueues.get(ctx.guild.id);
        if (!queue || queue.songs.length < 3) return ctx.reply('❌ Not enough songs to shuffle.');
        const first = queue.songs.shift(); queue.songs = shuffleArray(queue.songs); queue.songs.unshift(first);
        ctx.reply('🔀 Queue shuffled!');
    }
    else if (command === 'clear') {
        const queue = serverQueues.get(ctx.guild.id);
        if (!queue) return ctx.reply('❌ Nothing is playing!');
        if (queue.songs.length > 1) queue.songs = [queue.songs[0]];
        ctx.reply('🗑️ Queue cleared.');
    }
    else if (['np', 'nowplaying'].includes(command)) {
        const queue = serverQueues.get(ctx.guild.id);
        if (!queue || !queue.songs[0]) return ctx.reply('❌ Nothing is playing!');
        const song = queue.songs[0];
        const embed = new EmbedBuilder().setColor('#fc3c44').setAuthor({ name: 'Now Playing', iconURL: 'https://cdn-icons-png.flaticon.com/512/461/461163.png' }).setDescription(`**${song.title}**\n*by ${song.artist}*`).setThumbnail(song.thumbnail);
        ctx.reply({ embeds: [embed] });
    }
    else if (['queue', 'playlist', 'q'].includes(command)) {
        const queue = serverQueues.get(ctx.guild.id);
        if (!queue || queue.songs.length === 0) return ctx.reply('❌ The queue is empty.');
        let qStr = queue.songs.map((s, i) => `${i === 0 ? '**[Playing]**' : `**${i}.**`} ${s.title} - ${s.artist}`).slice(0, 10).join('\n');
        if (queue.songs.length > 10) qStr += `\n*...and ${queue.songs.length - 10} more*`;
        const embed = new EmbedBuilder().setColor('#fc3c44').setTitle('🎶 Current Playlist').setDescription(qStr);
        ctx.reply({ embeds: [embed] });
    }

    // --- MODERATION ---
    else if (command === 'ban') {
        if (!ctx.member.permissions.has('BanMembers')) return ctx.reply("❌ No perms.");
        const user = ctx.mentions.members.first();
        if (user) { await user.ban(); ctx.reply(`🔨 Banned ${user.user.tag}`); }
    }
    else if (command === 'kick') {
        if (!ctx.member.permissions.has('KickMembers')) return ctx.reply("❌ No perms.");
        const user = ctx.mentions.members.first();
        if (user) { await user.kick(); ctx.reply(`👢 Kicked ${user.user.tag}`); }
    }
    else if (command === 'timeout') {
        if (!ctx.member.permissions.has('ModerateMembers')) return ctx.reply("❌ No perms.");
        const user = ctx.mentions.users.first();
        const member = ctx.guild.members.cache.get(user?.id) || ctx.mentions.members.first();
        const mins = parseInt(args[1]) || 10;
        if (member) { await member.timeout(mins * 60 * 1000).catch(()=>{}); ctx.reply(`🤐 Timed out ${user.tag || member.user.tag} for ${mins} mins.`); }
        else { ctx.reply("User not found."); }
    }
    else if (['reactrole', 'rr'].includes(command)) {
        if (!ctx.member.permissions.has('ManageRoles')) return ctx.reply("❌ No perms.");
        if (args.length === 0) return ctx.reply("❌ Usage: `!rr @role :emoji: @role2 :emoji2:` (Up to 5 roles)");
        
        let roleMap = {};
        let desc = "React below to get your roles!\n\n";
        let count = 0;
        let emojisToReact = [];

        for (let i = 0; i < args.length; i++) {
            if (args[i].startsWith('<@&')) {
                const roleId = args[i].replace('<@&', '').replace('>', '');
                const emojiStr = args[i+1];
                if (roleId && emojiStr && count < 5) {
                    const roleObj = ctx.guild?.roles.cache.get(roleId);
                    if (roleObj) {
                        desc += `${emojiStr} - **${roleObj.name}**\n`;
                        let emojiKey = emojiStr.match(/\d+>/) ? emojiStr.match(/(\d+)>/)[1] : emojiStr;
                        roleMap[emojiKey] = roleId;
                        emojisToReact.push(emojiStr);
                        count++;
                    }
                }
            }
        }
        if (count === 0) return ctx.reply("❌ Couldn't find valid roles/emojis. Format: `!rr @role :emoji:`");

        const msg = await ctx.channelSend(desc);
        for (let e of emojisToReact) await msg.react(e).catch(()=>{});
        
        const rrDb = readDB(dbFiles.reactRoles); 
        rrDb[msg.id] = roleMap; 
        writeDB(dbFiles.reactRoles, rrDb);
        if (ctx.reply && rawMessage?.interaction) ctx.reply("✅ Roles setup successfully!"); 
    }

    // --- HELP ---
    else if (['help', 'h'].includes(command) && command !== 'hunt') {
        const embed = new EmbedBuilder()
            .setColor('#fc3c44')
            .setAuthor({ name: 'FUSION BOT COMMANDS', iconURL: 'https://cdn-icons-png.flaticon.com/512/10424/10424136.png' })
            .setDescription('Prefixes: `/`, `!`, `tpg`, `@tpg`, or ping me!')
            .addFields(
                { name: '💰 Economy & Games', value: '`/lb`, `daily`, `pray`, `profile`, `cash`, `cf <all/amt> [h/t]`, `s <all/amt>`, `h`, `give @user <all/amt>`, `ttt @user <bet>`' },
                { name: '🎵 Music', value: '`play`, `skip`, `pause`, `stop`, `leave`, `queue`, `loop`, `shuffle`, `clear`, `np`, `ping`' },
                { name: '🛡️ Moderation', value: '`ban @user`, `kick @user`, `timeout @user <min>`' }
            )
            .setThumbnail('https://cdn-icons-png.flaticon.com/512/10424/10424136.png');
        ctx.reply({ embeds: [embed] });
    }
}

async function playDiscordSong(guildId, song) {
    const queue = serverQueues.get(guildId);
    if (!song) { if(queue && queue.connection) queue.connection.destroy(); serverQueues.delete(guildId); return; }
    try {
        const streamUrl = await getStreamUrl(song.id);
        if (!streamUrl) { queue.songs.shift(); return playDiscordSong(guildId, queue.songs[0]); }
        const resource = createAudioResource(streamUrl, { inlineVolume: true }); 
        resource.volume.setVolume(queue.volume || 1.0);
        queue.resource = resource;
        queue.player.play(resource);
        
        const row1 = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('btn_prev').setLabel('⏮️').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('btn_pause').setLabel('⏯️').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('btn_skip').setLabel('⏭️').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('btn_stop').setLabel('⏹️').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId('btn_leave').setLabel('🚪').setStyle(ButtonStyle.Danger)
        );
        const row2 = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('btn_voldown').setLabel('🔉').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('btn_volup').setLabel('🔊').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('btn_loop').setLabel('🔁').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('btn_shuffle').setLabel('🔀').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('btn_queue').setLabel('📜').setStyle(ButtonStyle.Primary)
        );
        
        const embed = new EmbedBuilder()
            .setColor('#fc3c44')
            .setAuthor({ name: 'Now Playing', iconURL: 'https://cdn-icons-png.flaticon.com/512/461/461163.png' }) 
            .setDescription(`**${song.title}**\n*by ${song.artist}*`)
            .setThumbnail(song.thumbnail);
            
        queue.textChannel.send({ embeds: [embed], components: [row1, row2] });
    } catch (e) { queue.songs.shift(); playDiscordSong(guildId, queue.songs[0]); }
}

discordClient.login(DISCORD_TOKEN).catch(e => console.log("Discord Boot Error:", e.message));

// ==========================================
// 6. FUSIONMUSIC WEB SERVER API 
// ==========================================
const server = http.createServer(async (req, res) => {
  const { pathname, query } = url.parse(req.url, true);
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const sendJSON = (data, status=200) => { res.writeHead(status, {'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*'}); res.end(JSON.stringify(data)); };

  if (pathname.startsWith('/api/') && isRateLimited(ip)) return sendJSON({ error: "DDoS Protection Active." }, 429);

  try {
    if (pathname.startsWith('/api/auth/')) {
        const body = await parseBody(req); const users = readDB(dbFiles.users);
        if (pathname === '/api/auth/send-otp') {
            const { email, isRegister } = body;
            if (isRegister && users[email]) return sendJSON({ error: "Email registered." }, 400);
            const otp = Math.floor(100000 + Math.random() * 900000).toString();
            const otps = readDB(dbFiles.otps); otps[email] = { code: otp, expires: Date.now() + 600000 }; writeDB(dbFiles.otps, otps);
            await transporter.sendMail({ from: '"Fusion Team" <'+EMAIL_USER+'>', to: email, subject: "Code", text: `Your code: ${otp}` });
            return sendJSON({ success: true });
        }
        if (pathname === '/api/auth/verify') {
            const { email, otp, password } = body; const otps = readDB(dbFiles.otps);
            if (!otps[email] || otps[email].code !== otp || Date.now() > otps[email].expires) return sendJSON({ error: "Invalid Code" }, 400);
            users[email] = { password, name: "User" }; writeDB(dbFiles.users, users);
            return sendJSON({ success: true, token: email });
        }
        if (pathname === '/api/auth/login') {
            const { email, password } = body;
            if (!users[email] || users[email].password !== password) return sendJSON({ error: "Invalid Credentials" }, 400);
            return sendJSON({ success: true, token: email });
        }
        if (pathname === '/api/auth/forgot-password') {
            const { email } = body;
            if (!users[email]) return sendJSON({ error: "Email not found." }, 400);
            const token = crypto.randomBytes(32).toString('hex');
            const resets = readDB(dbFiles.resets); resets[token] = { email, expires: Date.now() + 15 * 60000 }; writeDB(dbFiles.resets, resets);
            const host = req.headers['x-forwarded-host'] || req.headers.host; const resetLink = `https://${host}/?reset=${token}`;
            await transporter.sendMail({ from: '"FusionMusic" <' + EMAIL_USER + '>', to: email, subject: "Reset", html: `<a href="${resetLink}">Reset Password</a>` }).catch(()=>{});
            return sendJSON({ success: true, message: "Link sent!" });
        }
        if (pathname === '/api/auth/reset-password') {
            const { token, newPassword } = body; const resets = readDB(dbFiles.resets);
            if (!resets[token] || Date.now() > resets[token].expires) return sendJSON({ error: "Invalid link." }, 400);
            users[resets[token].email].password = newPassword; writeDB(dbFiles.users, users); delete resets[token]; writeDB(dbFiles.resets, resets);
            return sendJSON({ success: true, token: resets[token].email });
        }
    }

    if (pathname.startsWith('/api/user/')) {
        const token = req.headers['authorization'];
        if (!token) return sendJSON({ error: "Unauthorized" }, 401);
        if (pathname === '/api/user/update-name') {
            const body = await parseBody(req); const users = readDB(dbFiles.users);
            if(users[token]) { users[token].name = body.name; writeDB(dbFiles.users, users); }
            return sendJSON({ success: true });
        }
        if (pathname === '/api/user/info') {
            const users = readDB(dbFiles.users); return sendJSON({ name: users[token] ? users[token].name : "User" });
        }
        if (pathname === '/api/user/liked') {
            const liked = readDB(dbFiles.liked);
            if (req.method === 'GET') return sendJSON(liked[token] || []);
            const body = await parseBody(req); liked[token] = liked[token] || [];
            if (body.action === 'add' && !liked[token].some(s => s.id === body.song.id)) liked[token].unshift(body.song);
            else if (body.action === 'remove') liked[token] = liked[token].filter(s => s.id !== body.songId);
            writeDB(dbFiles.liked, liked); return sendJSON({ success: true });
        }
        if (pathname === '/api/user/playlists') {
            const playlists = readDB(dbFiles.playlists); playlists[token] = playlists[token] || [];
            if (req.method === 'GET') return sendJSON(playlists[token]);
            const body = await parseBody(req);
            if (body.action === 'create') playlists[token].unshift({ id: Date.now().toString(), name: body.name, songs: [] });
            else if (body.action === 'edit_name') { const pl = playlists[token].find(p => p.id === body.playlistId); if (pl) pl.name = body.newName; }
            else if (body.action === 'delete') playlists[token] = playlists[token].filter(p => p.id !== body.playlistId);
            else if (body.action === 'add_song') { const pl = playlists[token].find(p => p.id === body.playlistId); if (pl && !pl.songs.some(s => s.id === body.song.id)) pl.songs.push(body.song); }
            else if (body.action === 'remove_song') { const pl = playlists[token].find(p => p.id === body.playlistId); if (pl) pl.songs = pl.songs.filter(s => s.id !== body.songId); }
            writeDB(dbFiles.playlists, playlists); return sendJSON({ success: true });
        }
    }

    if (pathname === '/api/public-playlist') {
        const playlists = readDB(dbFiles.playlists); let found = null;
        for (const user in playlists) {
            const pl = playlists[user].find(p => p.id === query.id);
            if (pl) { found = pl; break; }
        }
        return sendJSON({ playlist: found });
    }

    if (pathname === '/api/alexa-restart-12345') {
        sendJSON({ success: true, message: "Rebooting Engine..." });
        setTimeout(() => { exec('pkill -9 -f ssh'); process.exit(0); }, 1000);
        return;
    }

    if (pathname === '/api/translate') {
        const body = await parseBody(req);
        if (!body.text) return sendJSON({ error: "No text provided" }, 400);
        const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=en&dt=t&q=${encodeURIComponent(body.text)}`;
        https.get(url, (tRes) => {
            let data = ''; tRes.on('data', chunk => data += chunk);
            tRes.on('end', () => {
                try {
                    const parsed = JSON.parse(data); let translated = '';
                    parsed[0].forEach(arr => translated += arr[0] + ' ');
                    return sendJSON({ translated: translated.trim() });
                } catch(e) { return sendJSON({ error: "Translation failed" }, 500); }
            });
        }).on('error', () => sendJSON({ error: "Translation failed" }, 500));
        return;
    }

    if (pathname === '/api/getsong') { const s = await getSongInfo(query.id); return sendJSON({ song: s }); }
    if (pathname === '/api/streamurl') { const u = await getStreamUrl(query.id); return sendJSON({ url: u }); }
    if (pathname === '/api/lyrics') { const l = await fetchLyricsApi(query.title, query.artist); return sendJSON(l); }
    if (pathname === '/api/search') return sendJSON({ results: await searchYouTube(query.q, 15) });

    if (pathname === '/api/recommends') {
        let pool = globalRecommendsCache;
        if (pool.length === 0) {
            pool = await searchYouTube('latest global pop hits 2024', 30);
            globalRecommendsCache = pool;
        }
        return sendJSON({ results: shuffleArray(pool).slice(0, 15) });
    }

    let file = path.join(__dirname, pathname === '/' ? 'index.html' : pathname);
    if (!fs.existsSync(file)) file = path.join(__dirname, 'index.html');
    res.writeHead(200, {'Content-Type': { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.json': 'application/json', '.jpg': 'image/jpeg', '.png': 'image/png' }[path.extname(file)] || 'text/plain'});
    fs.createReadStream(file).pipe(res);
  } catch (err) { if(!res.headersSent) sendJSON({error: err.message}, 500); }
});

server.listen(PORT, '0.0.0.0', () => console.log(`Server & Master Bot Active on ${PORT}`));

setInterval(() => {
    const now = new Date();
    if ((now.getHours() === 0 || now.getHours() === 12) && now.getMinutes() === 0) { console.log("🛠 Scheduled maintenance restart..."); process.exit(0); }
}, 60000);
