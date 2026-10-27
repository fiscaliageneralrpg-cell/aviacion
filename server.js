const express = require('express');
const path = require('path');
const cors = require('cors');
const dotenv = require('dotenv');
const mysql = require('mysql2/promise');
const session = require('express-session');

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 3000);

app.set('trust proxy', 1);

console.log('🔧 Iniciando servidor...');
console.log('📋 DISCORD_CLIENT_ID:', process.env.DISCORD_CLIENT_ID ? '✅' : '❌ FALTANTE');
console.log('📋 DISCORD_CLIENT_SECRET:', process.env.DISCORD_CLIENT_SECRET ? '✅' : '❌ FALTANTE');
console.log('📋 ROBLOX_CLIENT_ID:', process.env.ROBLOX_CLIENT_ID ? '✅' : '❌ FALTANTE');
console.log('📋 SESSION_SECRET:', process.env.SESSION_SECRET ? '✅' : '❌ FALTANTE');
console.log('📋 DB_HOST:', process.env.DB_HOST);

// CORS
app.use(cors({
  origin: process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(',').map(s => s.trim())
    : ['*']
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Sesiones
app.use(session({
  secret: process.env.SESSION_SECRET || 'LANsecreto2026!MiClaveSegura',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000
  }
}));

// Archivos estáticos
app.use(express.static(path.join(__dirname, 'public')));

// --- Middleware: asegurar usuario de Discord en BD ---
async function ensureDiscordUserInDB(req, res, next) {
  if (req.session.discordUser) {
    try {
      const [existing] = await pool.query(
        'SELECT id FROM verified_users WHERE discord_id = ?',
        [req.session.discordUser.id]
      );
      if (existing.length === 0) {
        await pool.query(
          `INSERT INTO verified_users (discord_id, discord_username, discord_global_name, discord_avatar, discord_verified_at, fully_verified)
           VALUES (?, ?, ?, ?, NOW(), 0)`,
          [
            req.session.discordUser.id,
            req.session.discordUser.username,
            req.session.discordUser.global_name,
            req.session.discordUser.avatar
          ]
        );
      } else {
        await pool.query(
          `UPDATE verified_users 
           SET discord_username = ?, discord_global_name = ?, discord_avatar = ?, discord_verified_at = NOW(), updated_at = NOW()
           WHERE discord_id = ?`,
          [
            req.session.discordUser.username,
            req.session.discordUser.global_name,
            req.session.discordUser.avatar,
            req.session.discordUser.id
          ]
        );
      }
    } catch (err) {
      console.error('Error guardando usuario en BD:', err.message);
    }
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.session.discordUser) {
    return res.redirect('/iniciar-seccion.html');
  }
  next();
}

function requireGuest(req, res, next) {
  if (req.session.discordUser) {
    return res.redirect('/cargando.html');
  }
  next();
}

// ============================================
// RUTAS
// ============================================

app.get('/', requireGuest, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/iniciar-seccion.html', requireGuest, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'iniciar-seccion.html'));
});

app.get('/cargando.html', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'cargando.html'));
});

app.get('/verificacion.html', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'verificacion.html'));
});

app.get('/dashboard', requireAuth, (req, res) => {
  if (req.session.discordUser.fully_verified !== 1) {
    return res.redirect('/verificacion.html');
  }
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// --- API: stats ---
app.get('/api/stats', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT member_count FROM site_stats WHERE id = 1');
    res.json({ member_count: rows.length ? rows[0].member_count : 0 });
  } catch (err) {
    console.error('Error stats:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// --- API: me ---
app.get('/api/me', requireAuth, (req, res) => {
  res.json(req.session.discordUser);
});

// --- API: user-status ---
app.get('/api/user-status', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT fully_verified, roblox_id, roblox_username, roblox_avatar FROM verified_users WHERE discord_id = ?',
      [req.session.discordUser.id]
    );
    if (rows.length === 0) {
      return res.json({ fully_verified: 0, roblox_verified: false });
    }
    res.json({
      fully_verified: rows[0].fully_verified === 1,
      roblox_verified: !!rows[0].roblox_id,
      roblox_username: rows[0].roblox_username,
      roblox_avatar: rows[0].roblox_avatar
    });
  } catch (err) {
    console.error('Error user-status:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// --- Login Discord ---
app.get('/auth/discord/login', (req, res) => {
  const params = new URLSearchParams({
    client_id: process.env.DISCORD_CLIENT_ID,
    redirect_uri: 'https://latinaviationnetwork.com/auth/discord/callback',
    response_type: 'code',
    scope: 'identify'
  });
  res.redirect(`https://discord.com/api/oauth2/authorize?${params}`);
});

// --- Callback Discord ---
app.get('/auth/discord/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) {
    console.error('❌ No hay código de autorización');
    return res.status(400).send('No se proporcionó código de Discord');
  }

  try {
    console.log('🔄 Intercambiando código por token...');
    const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.DISCORD_CLIENT_ID,
        client_secret: process.env.DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: 'https://latinaviationnetwork.com/auth/discord/callback'
      })
    });

    console.log('📡 Status token:', tokenResponse.status);

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      console.error('❌ Error token Discord:', errorText);
      throw new Error('Error obteniendo token de Discord');
    }

    const tokenData = await tokenResponse.json();
    console.log('✅ Token obtenido');

    const userResponse = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `${tokenData.token_type} ${tokenData.access_token}` }
    });

    if (!userResponse.ok) {
      const errText = await userResponse.text();
      console.error('❌ Error usuario Discord:', errText);
      throw new Error('Error obteniendo usuario de Discord');
    }

    const user = await userResponse.json();
    console.log('✅ Usuario:', user.global_name || user.username);

    req.session.discordUser = {
      id: user.id,
      username: user.username,
      global_name: user.global_name,
      avatar: user.avatar,
      fully_verified: 0
    };

    // Guardar/actualizar en BD
    const [existing] = await pool.query(
      'SELECT id, fully_verified FROM verified_users WHERE discord_id = ?',
      [user.id]
    );
    if (existing.length === 0) {
      await pool.query(
        `INSERT INTO verified_users (discord_id, discord_username, discord_global_name, discord_avatar, discord_verified_at, fully_verified)
         VALUES (?, ?, ?, ?, NOW(), 0)`,
        [user.id, user.username, user.global_name, user.avatar]
      );
    } else {
      await pool.query(
        `UPDATE verified_users 
         SET discord_username = ?, discord_global_name = ?, discord_avatar = ?, discord_verified_at = NOW(), updated_at = NOW()
         WHERE discord_id = ?`,
        [user.username, user.global_name, user.avatar, user.id]
      );
      req.session.discordUser.fully_verified = existing[0].fully_verified === 1;
    }

    console.log('🚀 Redirigiendo a /cargando.html');
    res.redirect('/cargando.html');
  } catch (err) {
    console.error('❌ Error Discord OAuth:', err.message);
    res.status(500).send('Error autenticando con Discord: ' + err.message);
  }
});

// --- Login Roblox ---
app.get('/auth/roblox/login', requireAuth, (req, res) => {
  const ROBLOX_CLIENT_ID = process.env.ROBLOX_CLIENT_ID;
  if (!ROBLOX_CLIENT_ID) {
    return res.status(500).send('ROBLOX_CLIENT_ID no configurado');
  }
  const redirectUri = encodeURIComponent('https://latinaviationnetwork.com/auth/roblox/callback');
  const state = encodeURIComponent('guild::' + req.session.discordUser.id);
  const scope = encodeURIComponent('openid profile');
  const url = `https://apis.roblox.com/oauth2/v1/authorize?client_id=${ROBLOX_CLIENT_ID}&response_type=code&redirect_uri=${redirectUri}&scope=${scope}&state=${state}&step=accountConfirm`;
  res.redirect(url);
});

// --- Callback Roblox ---
app.get('/auth/roblox/callback', requireAuth, async (req, res) => {
  const code = req.query.code;
  const state = req.query.state;
  if (!code || !state) {
    return res.status(400).send('Faltan parámetros de Roblox');
  }

  const discordId = state.replace('guild::', '');
  if (discordId !== req.session.discordUser.id) {
    return res.status(403).send('State no coincide con el usuario de Discord');
  }

  try {
    const tokenResponse = await fetch('https://apis.roblox.com/oauth2/v1/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + Buffer.from(
          process.env.ROBLOX_CLIENT_ID + ':' + process.env.ROBLOX_CLIENT_SECRET
        ).toString('base64')
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: 'https://latinaviationnetwork.com/auth/roblox/callback'
      })
    });

    if (!tokenResponse.ok) {
      const errText = await tokenResponse.text();
      console.error('Roblox token error:', errText);
      throw new Error('Error obteniendo token de Roblox');
    }

    const tokenData = await tokenResponse.json();

    const userResponse = await fetch('https://apis.roblox.com/users/v1/users/authenticated', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });

    if (!userResponse.ok) throw new Error('Error obteniendo perfil de Roblox');

    const robloxUser = await userResponse.json();

    await pool.query(
      `UPDATE verified_users 
       SET roblox_id = ?, roblox_username = ?, roblox_avatar = ?, roblox_verified_at = NOW(), updated_at = NOW()
       WHERE discord_id = ?`,
      [
        robloxUser.id,
        robloxUser.name,
        `https://www.roblox.com/headshot-thumbnail/image?userId=${robloxUser.id}&width=420&height=420&format=png`,
        discordId
      ]
    );

    req.session.discordUser.roblox_id = robloxUser.id;
    req.session.discordUser.roblox_username = robloxUser.name;
    req.session.discordUser.roblox_avatar = `https://www.roblox.com/headshot-thumbnail/image?userId=${robloxUser.id}&width=420&height=420&format=png`;

    res.redirect('/verificacion.html?step=3&verified=roblox');
  } catch (err) {
    console.error('Error Roblox callback:', err.message);
    res.status(500).send('Error verificando Roblox: ' + err.message);
  }
});

// --- Marcar verificación completa ---
app.post('/api/verify-complete', requireAuth, async (req, res) => {
  try {
    await pool.query(
      `UPDATE verified_users SET fully_verified = 1, updated_at = NOW() WHERE discord_id = ?`,
      [req.session.discordUser.id]
    );
    req.session.discordUser.fully_verified = 1;
    res.json({ success: true, redirect: '/dashboard' });
  } catch (err) {
    console.error('Error verify-complete:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// --- Logout ---
app.get('/auth/logout', (req, res) => {
  req.session.destroy();
  res.clearCookie('connect.sid');
  res.redirect('/');
});

// Pool MySQL
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Servidor en http://0.0.0.0:${PORT}`);
});
