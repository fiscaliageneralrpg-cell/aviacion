const express = require('express');
const path = require('path');
const cors = require('cors');
const dotenv = require('dotenv');
const mysql = require('mysql2/promise');
const session = require('express-session');

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

// --- API: obtener usuario logueado ---
app.get('/api/me', (req, res) => {
  if (!req.session.discordUser) {
    return res.status(401).json({ error: 'No autenticado' });
  }
  res.json(req.session.discordUser);
});

// --- Ruta principal: sirve index.html ---
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
    res.status(500).send('Error autenticando con Discord: ' + err.message);
  }
});

// --- Ruta: dashboard protegido (sirve dashboard.html) ---
app.get('/dashboard', (req, res) => {
  if (!req.session.discordUser) {
    return res.redirect('/iniciar-seccion.html');
  }
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
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
