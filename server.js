const express = require('express');
const path = require('path');
const cors = require('cors');
const dotenv = require('dotenv');
const mysql = require('mysql2/promise');
const session = require('express-session');
const fetch = require('node-fetch');

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 3000);

// CORS
app.use(cors({
  origin: process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(',').map(s => s.trim())
    : ['*']
}));
app.use(express.json());

// Sesiones
app.use(session({
  secret: process.env.SESSION_SECRET || 'cambia_esto_por_algo_muy_secreto_12345',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    maxAge: 24 * 60 * 60 * 1000
  }
}));

// Servir archivos estáticos desde public/
app.use(express.static(path.join(__dirname, 'public')));

// --- API: obtener número de miembros ---
app.get('/api/stats', async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT member_count FROM site_stats WHERE id = 1'
    );
    if (rows.length === 0) {
      return res.json({ member_count: 0 });
    }
    res.json({ member_count: rows[0].member_count });
  } catch (err) {
    console.error('Error al obtener stats:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// --- Ruta principal: sirve el index.html de public ---
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- Ruta: iniciar login de Discord ---
app.get('/auth/discord/login', (req, res) => {
  const params = new URLSearchParams({
    client_id: process.env.DISCORD_CLIENT_ID,
    redirect_uri: 'https://latinaviationnetwork.com/auth/discord/callback',
    response_type: 'code',
    scope: 'identify'
  });
  res.redirect(`https://discord.com/api/oauth2/authorize?${params}`);
});

// --- Ruta: callback de Discord ---
app.get('/auth/discord/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send('No se proporcionó código de Discord');

  try {
    // 1. Intercambiar código por access token
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

    if (!tokenResponse.ok) throw new Error('Error obteniendo token');

    const tokenData = await tokenResponse.json();

    // 2. Obtener datos del usuario de Discord
    const userResponse = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `${tokenData.token_type} ${tokenData.access_token}` }
    });

    if (!userResponse.ok) throw new Error('Error obteniendo usuario');

    const user = await userResponse.json();

    // 3. Guardar en sesión
    req.session.discordUser = {
      id: user.id,
      username: user.username,
      global_name: user.global_name,
      avatar: user.avatar
    };

    // 4. Redirigir al dashboard
    res.redirect('/dashboard');
  } catch (err) {
    console.error('Error Discord OAuth:', err.message);
    res.status(500).send('Error autenticando con Discord');
  }
});

// --- Ruta: dashboard protegido ---
app.get('/dashboard', (req, res) => {
  if (!req.session.discordUser) {
    return res.redirect('/iniciar-seccion.html');
  }
  const user = req.session.discordUser;
  res.send(`
    <!DOCTYPE html>
    <html lang="es">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Dashboard | LAN</title>
      <link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@700;900&display=swap" rel="stylesheet">
      <style>
        body { background: #030305; color: #fff; font-family: 'Orbitron', monospace; text-align: center; padding-top: 100px; }
        .card { max-width: 400px; margin: 0 auto; background: #0d0d12; border: 1px solid #1f2937; border-radius: 20px; padding: 40px; box-shadow: 0 25px 50px rgba(0,0,0,0.6); }
        .avatar { width: 80px; height: 80px; border-radius: 50%; border: 2px solid #0066ff; margin-bottom: 20px; }
        h1 { background: linear-gradient(135deg, #fff, #0066ff); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
        a { color: #0066ff; text-decoration: none; }
        a:hover { text-decoration: underline; }
      </style>
    </head>
    <body>
      <div class="card">
        <img src="https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png" alt="Avatar" class="avatar">
        <h1>Hola, ${user.global_name || user.username}</h1>
        <p>Has iniciado sesión con Discord correctamente.</p>
        <p>ID: ${user.id}</p>
        <br>
        <a href="/auth/logout">Cerrar sesión</a> | <a href="/">Volver al inicio</a>
      </div>
    </body>
    </html>
  `);
});

// --- Ruta: cerrar sesión ---
app.get('/auth/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

// Pool de conexión a MySQL remoto
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
  console.log(`Servidor web en http://0.0.0.0:${PORT}`);
});
