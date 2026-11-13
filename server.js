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
console.log('📋 DISCORD_BOT_TOKEN:', process.env.DISCORD_BOT_TOKEN ? '✅ (DM directo activo)' : '⚠️ no configurado (los DM quedan en cola para el bot)');
console.log('📋 ROBLOX_CLIENT_ID:', process.env.ROBLOX_CLIENT_ID ? '✅' : '❌ FALTANTE (app en revisión)');
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

// 🔒 Las copias estáticas del dashboard se sirven desde public/ (express.static
// no aplica middlewares de ruta), así que aquí se exige la MISMA verificación
// que en /dashboard. Sin esto, cualquier usuario logueado pero sin verificar
// podía abrir /dashboard.html o /dashboard-aviacion.html a mano y saltarse
// el paso de Roblox.
app.use((req, res, next) => {
  if (req.path === '/dashboard.html' || req.path === '/dashboard-aviacion.html') {
    return requireVerificado(req, res, next);
  }
  next();
});

// 🧹 Sin caché para HTML: así el navegador siempre baja la versión nueva del
// dashboard/formulario tras cada despliegue (antes quedaba guardada la página
// vieja y seguía apareciendo el modal de ruta automático).
app.use((req, res, next) => {
  if (req.path.endsWith('.html')) {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  }
  next();
});

// Archivos estáticos
app.use(express.static(path.join(__dirname, 'public')));

// Pool de conexión a MySQL remoto (se crea antes de usarse)
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10
});

// ============================================
// UTILIDADES DE VERIFICACIÓN
// (MySQL puede devolver fully_verified como 1, '1', true o Buffer)
// ============================================
function esVerificado(v) {
  if (v === true || v === 1) return true;
  if (typeof v === 'string') return v === '1';
  if (Buffer.isBuffer(v)) return v.length > 0 && v.some(b => b !== 0);
  return false;
}

// Lee SIEMPRE el mejor registro del usuario (sirve aunque haya filas duplicadas)
async function obtenerEstadoVerificado(discordId) {
  const [rows] = await pool.query(
    'SELECT id, fully_verified, roblox_id, roblox_username, roblox_avatar FROM verified_users WHERE discord_id = ? ORDER BY id ASC',
    [discordId]
  );
  const roblox = rows.find(r => r.roblox_id) || null;
  const verificado = rows.some(r => esVerificado(r.fully_verified));

  // AUTO-SANACIÓN: si ya tiene Roblox conectado pero fully_verified quedó en 0
  // (porque la página nunca llamó a /api/verify-complete), se completa aquí.
  // Discord + Roblox = verificación completa → nadie queda trabado en cargando.
  if (roblox && !verificado) {
    try {
      await pool.query(
        'UPDATE verified_users SET fully_verified = 1, updated_at = NOW() WHERE discord_id = ?',
        [discordId]
      );
      console.log(`✅ Verificación auto-completada (Roblox conectado): ${discordId}`);
      return {
        existe: true,
        fully_verified: true,
        roblox_id: roblox.roblox_id,
        roblox_username: roblox.roblox_username,
        roblox_avatar: roblox.roblox_avatar
      };
    } catch (err) {
      console.error('Error auto-completando verificación:', err.message);
    }
  }

  return {
    existe: rows.length > 0,
    fully_verified: verificado,
    roblox_id: roblox ? roblox.roblox_id : null,
    roblox_username: roblox ? roblox.roblox_username : null,
    roblox_avatar: roblox ? roblox.roblox_avatar : null
  };
}

// Limpia duplicados y asegura la clave única de verified_users
// (sin ella, /api/verify-complete creaba una fila NUEVA en cada verificación
//  y la lectura seguía devolviendo la fila vieja → "sigo sin verificar")
async function ensureVerifiedUsersTable() {
  try {
    const [dups] = await pool.query(
      'SELECT discord_id FROM verified_users GROUP BY discord_id HAVING COUNT(*) > 1'
    );
    if (dups.length) {
      console.log(`🧹 Limpiando ${dups.length} usuario(s) duplicado(s) en verified_users...`);
      for (const d of dups) {
        const [rs] = await pool.query(
          'SELECT id, fully_verified, roblox_id, roblox_username, roblox_avatar FROM verified_users WHERE discord_id = ? ORDER BY id ASC',
          [d.discord_id]
        );
        const verificado = rs.some(r => esVerificado(r.fully_verified));
        const roblox = rs.find(r => r.roblox_id) || null;
        const keeper = rs[rs.length - 1];
        await pool.query(
          'UPDATE verified_users SET fully_verified = ?, roblox_id = ?, roblox_username = ?, roblox_avatar = ?, updated_at = NOW() WHERE id = ?',
          [verificado ? 1 : 0, roblox ? roblox.roblox_id : null, roblox ? roblox.roblox_username : null, roblox ? roblox.roblox_avatar : null, keeper.id]
        );
        const borrar = rs.filter(r => r.id !== keeper.id).map(r => r.id);
        await pool.query('DELETE FROM verified_users WHERE id IN (?)', [borrar]);
      }
      console.log('✅ Duplicados de verified_users eliminados.');
    }
    // Ruta elegida por el usuario tras verificar: 'piloto' | 'atc' | NULL (sin elegir)
    try {
      await pool.query('ALTER TABLE verified_users ADD COLUMN track VARCHAR(10) DEFAULT NULL');
      console.log('🧭 Columna verified_users.track lista.');
    } catch (e) {
      if (e.code !== 'ER_DUP_FIELDNAME') console.error('Error agregando verified_users.track:', e.message);
    }
    await pool.query('ALTER TABLE verified_users ADD UNIQUE KEY uniq_verified_discord (discord_id)');
    console.log('🔑 Índice único verified_users.discord_id listo.');
  } catch (err) {
    if (err.code === 'ER_DUP_KEYNAME') console.log('🔑 Índice único verified_users.discord_id ya existe.');
    else console.error('Error asegurando verified_users:', err.message);
  }
}
ensureVerifiedUsersTable();

// ============================================
// MIDDLEWARES
// ============================================

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

// 🔒 Exige verificación COMPLETA (Discord + Roblox) para entrar al dashboard.
// Sin esto, escribir /dashboard a mano saltaba todo el paso de Roblox.
async function requireVerificado(req, res, next) {
  if (!req.session.discordUser) {
    return res.redirect('/iniciar-seccion.html');
  }
  try {
    const estado = await obtenerEstadoVerificado(req.session.discordUser.id);
    if (estado.fully_verified && estado.roblox_id) {
      return next();
    }
  } catch (err) {
    console.error('Error requireVerificado:', err.message);
  }
  return res.redirect('/verificacion.html');
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

app.get('/dashboard', requireVerificado, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// --- Páginas legales (para revisión de Roblox OAuth) ---
app.get('/privacidad', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'privacidad.html'));
});

app.get('/terminos', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'terminos.html'));
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

// --- API: user-status (crea la fila si no existe y devuelve roblox_id) ---
app.get('/api/user-status', requireAuth, async (req, res) => {
  try {
    const discordId = req.session.discordUser.id;
    let estado = await obtenerEstadoVerificado(discordId);

    if (!estado.existe) {
      await pool.query(
        `INSERT INTO verified_users (discord_id, discord_username, discord_global_name, discord_avatar, discord_verified_at, fully_verified)
         VALUES (?, ?, ?, ?, NOW(), 0)`,
        [discordId, req.session.discordUser.username, req.session.discordUser.global_name, req.session.discordUser.avatar]
      );
      estado = { existe: true, fully_verified: false, roblox_id: null, roblox_username: null, roblox_avatar: null };
    }

    // La BD y la sesión mandan (si alguno dice verificado, está verificado)
    const fullyVerified = estado.fully_verified || esVerificado(req.session.discordUser.fully_verified);

    res.json({
      fully_verified: fullyVerified,
      roblox_verified: !!estado.roblox_id,
      roblox_id: estado.roblox_id || null,
      roblox_username: estado.roblox_username || null,
      roblox_avatar: estado.roblox_avatar || null
    });
  } catch (err) {
    console.error('Error user-status:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ============================================
// RANGOS DE DISCORD
// (los escribe el bot en la tabla user_roles,
//  aquí SOLO se leen de la BD — sin token en Render)
// ============================================
const DISCORD_RANKS = [
  { id: '1555489319639191653', name: 'Piloto En Formación',              short: 'PCA En Formación',       color: '#94a3b8' },
  { id: '1555512471383441408', name: 'Controlador Aéreo En Formación',   short: 'ATC En Formación',       color: '#64748b' },
  { id: '1559429028333621369', name: 'Piloto En Práctica',               short: 'PCA En Práctica',        color: '#38bdf8' },
  { id: '1555489377151623178', name: 'Piloto',                           short: 'Pilot',                  color: '#0066ff' },
  { id: '1555512718046404609', name: 'Controlador Aéreo',                short: 'Air Traffic Controller', color: '#00ff88' },
  { id: '1555512949391495218', name: 'Instructor ATC',                   short: 'Instructor ATC',         color: '#00d4ff' },
  { id: '1556059095277109348', name: 'Instructor PCA',                   short: 'Instructor PCA',         color: '#a855f7' },
  { id: '1559433801162170378', name: 'Director Académico',               short: 'Director Académico',     color: '#ff9f43' },
  { id: '1557648392362922014', name: 'Co Funder',                        short: 'Co Funder',              color: '#f43f5e' },
  { id: '1555480212051857418', name: 'Fundador',                         short: 'Fundador',               color: '#ffd700' }
];

// --- API: rangos del usuario (LEÍDOS DE LA BD, los escribe el bot) ---
app.get('/api/roles', requireAuth, async (req, res) => {
  try {
    const discordId = String(req.session.discordUser.id);

    // La tabla user_roles la mantiene el bot de Discord (Pterodactyl)
    const [rows] = await pool.query(
      'SELECT role_ids FROM user_roles WHERE discord_id = ?',
      [discordId]
    );

    if (!rows.length) {
      return res.json({ ranks: [], highest: null });
    }

    // role_ids viene ordenado del rango MÁS ALTO primero (lo escribe el bot)
    const ids = String(rows[0].role_ids || '').split(',').map(s => s.trim()).filter(Boolean);
    const ranks = ids
      .map(id => DISCORD_RANKS.find(r => r.id === id))
      .filter(Boolean);

    console.log(`🎖️ /api/roles (BD) | user=${discordId} | rangos=${ranks.length} | principal=${ranks[0] ? ranks[0].name : 'ninguno'}`);
    res.json({ ranks, highest: ranks[0] || null });
  } catch (err) {
    console.error('Error /api/roles:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ============================================
// LAN ACADEMY — FORMULARIO Y PANEL STAFF
// ============================================
const ACADEMY_FORM_ROLE = '1555489319639191653';           // Piloto En Formación → habilita el formulario
const ACADEMY_ROL_SALIDA = '1555489319639191653';           // rol que se QUITA al aprobar
const ACADEMY_ROL_ENTRADA = '1559429028333621369';          // Piloto En Práctica → rol que se DA
const STAFF_ROLES = [
  '1555480212051857418', // Fundador
  '1557648392362922014', // Co Funder
  '1559433801162170378'  // Director Académico
];

// Respuestas correctas de las preguntas CERRADAS (15)
const ACADEMY_KEY = {
  1: 'B', 2: 'C', 3: 'Falso', 4: 'B',
  6: 'B', 7: 'C', 8: 'Verdadero', 9: 'B',
  11: 'B', 12: 'Verdadero', 13: 'B', 15: 'B',
  16: 'B', 18: 'B', 19: 'Verdadero'
};
// Preguntas ABIERTAS (las califica el staff: good = buena, bad = mala)
const ACADEMY_ABIERTAS = [5, 10, 14, 17, 20];

// Tablas necesarias (se crean solas al arrancar)
async function ensureAcademyTables() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_roles (
        discord_id VARCHAR(20) NOT NULL,
        role_ids TEXT NOT NULL,
        highest_role_id VARCHAR(20) DEFAULT NULL,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (discord_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS academy_submissions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        discord_id VARCHAR(20) NOT NULL,
        answers TEXT NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'submitted',
        score INT DEFAULT NULL,
        total INT NOT NULL DEFAULT 20,
        staff_discord_id VARCHAR(20) DEFAULT NULL,
        graded_at DATETIME DEFAULT NULL,
        role_action TINYINT NOT NULL DEFAULT 0,
        role_action_done TINYINT NOT NULL DEFAULT 0,
        denied_ack TINYINT NOT NULL DEFAULT 0,
        dm_pending TINYINT NOT NULL DEFAULT 0,
        denied_at DATETIME DEFAULT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        KEY idx_academy_discord (discord_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // Tablas que ya existían sin las columnas nuevas:
    //   denied_ack → el usuario ya aceptó el aviso de "denegado" en la web del formulario
    //   dm_pending → el DM de "denegado" aún no se ha enviado (lo puede enviar el bot)
    //   denied_at  → cuándo se denegó (controla el cooldown de 1 hora para reintentar)
    const columnasNuevas = [
      'ALTER TABLE academy_submissions ADD COLUMN denied_ack TINYINT NOT NULL DEFAULT 0',
      'ALTER TABLE academy_submissions ADD COLUMN dm_pending TINYINT NOT NULL DEFAULT 0',
      'ALTER TABLE academy_submissions ADD COLUMN denied_at DATETIME DEFAULT NULL'
    ];
    for (const sql of columnasNuevas) {
      try {
        await pool.query(sql);
      } catch (e) {
        if (e.code !== 'ER_DUP_FIELDNAME') console.error('Error agregando columna academy:', e.message);
      }
    }

    console.log('🗂️ Tablas user_roles + academy_submissions listas.');
  } catch (err) {
    console.error('Error creando tablas academy:', err.message);
  }
}
ensureAcademyTables();

async function obtenerRangosIds(discordId) {
  const [rows] = await pool.query('SELECT role_ids FROM user_roles WHERE discord_id = ?', [String(discordId)]);
  if (!rows.length) return [];
  return String(rows[0].role_ids || '').split(',').map(s => s.trim()).filter(Boolean);
}

async function esStaff(discordId) {
  const ids = await obtenerRangosIds(discordId);
  return STAFF_ROLES.some(r => ids.includes(r));
}

// --------------------------------------------
// DM por Discord (necesita DISCORD_BOT_TOKEN en las variables de entorno).
// Devuelve true si el mensaje se envió. Si falla (sin token, DMs cerrados, etc.)
// devuelve false y el aviso queda con dm_pending = 1 para que el bot lo reintente.
// --------------------------------------------
async function enviarDM(discordId, mensaje) {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) return false;

  const headers = {
    Authorization: `Bot ${token}`,
    'Content-Type': 'application/json'
  };

  try {
    const canalRes = await fetch('https://discord.com/api/v10/users/@me/channels', {
      method: 'POST',
      headers,
      body: JSON.stringify({ recipient_id: String(discordId) }),
      signal: AbortSignal.timeout(8000)
    });
    if (!canalRes.ok) throw new Error('No se pudo abrir el DM (' + canalRes.status + ')');
    const canal = await canalRes.json();

    const msgRes = await fetch(`https://discord.com/api/v10/channels/${canal.id}/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify(mensaje),
      signal: AbortSignal.timeout(8000)
    });
    if (!msgRes.ok) throw new Error('No se pudo enviar el DM (' + msgRes.status + ')');
    return true;
  } catch (err) {
    console.error(`⚠️ DM a ${discordId} falló:`, err.message);
    return false;
  }
}

function mensajeDenegado(score, total) {
  const puntaje = (score != null) ? `\n\n**Puntaje obtenido:** ${score}/${total || 20}` : '';
  return {
    content: 'Hola, tienes una novedad sobre tu formulario de LAN Academy.',
    embeds: [{
      title: 'Tu formulario de LAN Academy fue denegado',
      description:
        'Un staff revisó tus respuestas y esta vez no fue aprobado.' + puntaje +
        '\n\nNo te preocupes, puedes volver a intentarlo: entra a tu dashboard, abre el formulario, ' +
        'acepta el aviso y respóndelo de nuevo.',
      url: 'https://latinaviationnetwork.com/dashboard',
      color: 0xf43f5e,
      footer: { text: 'LAN Academy · Latin Aviation Network' },
      timestamp: new Date().toISOString()
    }]
  };
}

// --- Página del formulario ---
app.get('/dashboard/formulario-lan-academy', requireVerificado, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'formulario-lan-academy.html'));
});
app.get('/formulario-lan-academy.html', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'formulario-lan-academy.html'));
});

// --- Cooldowns de reenvío del formulario ---
//   • Denegado  → puede volver a enviarlo 1 hora después de la denegación.
//   • En revisión sin respuesta → puede volver a enviarlo 24 horas después del envío.
const COOLDOWN_DENEGADO_MS = 60 * 60 * 1000;        // 1 hora
const COOLDOWN_REVISION_MS = 24 * 60 * 60 * 1000;   // 24 horas

function tiempoHumano(seg) {
  if (seg <= 0) return 'ya';
  const m = Math.ceil(seg / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), mm = m % 60;
  return mm ? `${h} h ${mm} min` : `${h} h`;
}

// Calcula si el usuario ya puede volver a enviar y cuánto falta (en segundos)
function calcularReintento(last) {
  if (!last) return { retry_ready: true, retry_wait: 0 };
  const ahora = Date.now();

  if (last.status === 'approved') {
    return { retry_ready: false, retry_wait: 0 };           // aprobado: ya no hace falta
  }
  if (last.status === 'denied') {
    const base = new Date(last.denied_at || last.updated_at).getTime();
    const libre = base + COOLDOWN_DENEGADO_MS;
    if (ahora < libre) return { retry_ready: false, retry_wait: Math.ceil((libre - ahora) / 1000) };
    return { retry_ready: true, retry_wait: 0 };
  }
  if (last.status === 'submitted') {
    const libre = new Date(last.created_at).getTime() + COOLDOWN_REVISION_MS;
    if (ahora < libre) return { retry_ready: false, retry_wait: Math.ceil((libre - ahora) / 1000) };
    return { retry_ready: true, retry_wait: 0 };
  }
  // 'graded' → el staff ya calificó, se espera su decisión
  return { retry_ready: false, retry_wait: 0 };
}

// --- Estado del formulario del usuario ---
app.get('/api/academy/status', requireAuth, async (req, res) => {
  try {
    const discordId = String(req.session.discordUser.id);
    const ids = await obtenerRangosIds(discordId);

    const [rows] = await pool.query(
      `SELECT status, score, total, created_at, updated_at, denied_at, denied_ack
       FROM academy_submissions
       WHERE discord_id = ? ORDER BY id DESC LIMIT 1`,
      [discordId]
    );
    const last = rows[0] || null;
    const reintento = calcularReintento(last);

    res.json({
      has_form_role: ids.includes(ACADEMY_FORM_ROLE),
      is_staff: STAFF_ROLES.some(r => ids.includes(r)),
      status: last ? last.status : 'none',   // none | submitted | graded | approved | denied
      score: last && last.score != null ? last.score : null,
      total: last && last.total != null ? last.total : 20,
      submitted_at: last ? last.created_at : null,
      denied_ack: last ? !!last.denied_ack : false,   // true cuando ya aceptó el aviso de denegado
      retry_ready: reintento.retry_ready,             // true → ya puede volver a enviar
      retry_wait: reintento.retry_wait                // segundos restantes del cooldown
    });
  } catch (err) {
    console.error('Error academy/status:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// --- Enviar formulario ---
app.post('/api/academy/submit', requireAuth, async (req, res) => {
  try {
    const discordId = String(req.session.discordUser.id);

    const [prev] = await pool.query(
      'SELECT id, status, denied_ack, created_at, updated_at, denied_at FROM academy_submissions WHERE discord_id = ? ORDER BY id DESC LIMIT 1',
      [discordId]
    );

    let reemplazarId = null;   // si hay un envío viejo sin respuesta (>24h), se reemplaza
    if (prev.length) {
      const p = prev[0];
      const reintento = calcularReintento(p);

      if (p.status === 'approved') {
        return res.status(409).json({ error: 'Tu formulario ya fue aprobado.' });
      }
      if (p.status === 'graded') {
        return res.status(409).json({ error: 'Tu formulario ya fue calificado: esperando la decisión del staff.' });
      }
      if (p.status === 'denied') {
        if (!p.denied_ack) {
          return res.status(409).json({ error: 'Primero acepta el aviso de formulario denegado.' });
        }
        if (!reintento.retry_ready) {
          return res.status(409).json({
            error: `Tu intento fue denegado: podrás volver a enviarlo en ${tiempoHumano(reintento.retry_wait)}.`,
            retry_wait: reintento.retry_wait
          });
        }
        // denegado + aceptado + 1 hora cumplida → se guarda como intento nuevo
      }
      if (p.status === 'submitted') {
        if (!reintento.retry_ready) {
          return res.status(409).json({
            error: `Tu formulario está en revisión. Si en 24 h no hay respuesta podrás volver a enviarlo (faltan ${tiempoHumano(reintento.retry_wait)}).`,
            retry_wait: reintento.retry_wait
          });
        }
        // sin respuesta después de 24 h → se reemplaza el mismo envío
        reemplazarId = p.id;
      }
    }

    const answers = (req.body && req.body.answers) ? req.body.answers : {};
    const faltantes = [];
    for (let i = 1; i <= 20; i++) {
      if (!answers[i] || !String(answers[i]).trim()) faltantes.push(i);
    }
    if (faltantes.length) {
      return res.status(400).json({ error: 'Faltan preguntas: ' + faltantes.join(', ') });
    }

    if (reemplazarId != null) {
      await pool.query(
        `UPDATE academy_submissions
         SET answers = ?, status = 'submitted', score = NULL, staff_discord_id = NULL,
             graded_at = NULL, denied_ack = 0, dm_pending = 0, denied_at = NULL,
             created_at = NOW(), updated_at = NOW()
         WHERE id = ?`,
        [JSON.stringify(answers), reemplazarId]
      );
      console.log(`📝 Academy: envío reemplazado (sin respuesta >24 h) de ${discordId}`);
    } else {
      await pool.query(
        `INSERT INTO academy_submissions (discord_id, answers, status, total)
         VALUES (?, ?, 'submitted', 20)`,
        [discordId, JSON.stringify(answers)]
      );
      console.log(`📝 Academy: formulario recibido de ${discordId}`);
    }

    res.json({ success: true, status: 'submitted' });
  } catch (err) {
    console.error('Error academy/submit:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// --- El usuario acepta el aviso de "denegado" (después puede rehacer el formulario) ---
app.post('/api/academy/ack-denied', requireAuth, async (req, res) => {
  try {
    const discordId = String(req.session.discordUser.id);

    const [rows] = await pool.query(
      'SELECT id, status FROM academy_submissions WHERE discord_id = ? ORDER BY id DESC LIMIT 1',
      [discordId]
    );
    if (!rows.length || rows[0].status !== 'denied') {
      return res.status(409).json({ error: 'No tienes un formulario denegado pendiente de aceptar.' });
    }

    await pool.query('UPDATE academy_submissions SET denied_ack = 1 WHERE id = ?', [rows[0].id]);
    console.log(`♻️ Academy: ${discordId} aceptó el aviso de denegado (#${rows[0].id})`);
    res.json({ success: true });
  } catch (err) {
    console.error('Error academy/ack-denied:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// --- RUTA: Piloto o ATC (solo DESPUÉS de que el staff apruebe el formulario) ---
function ultimoEstadoAcademy(discordId) {
  return pool.query(
    'SELECT status FROM academy_submissions WHERE discord_id = ? ORDER BY id DESC LIMIT 1',
    [discordId]
  ).then(([rows]) => (rows.length ? rows[0].status : null));
}

app.get('/api/track', requireAuth, async (req, res) => {
  try {
    const discordId = String(req.session.discordUser.id);
    // Sin formulario aprobado no hay ruta que mostrar (aunque quede guardada
    // de una prueba vieja): el chip y el embed los decide el estado del form.
    const status = await ultimoEstadoAcademy(discordId);
    if (status !== 'approved') return res.json({ track: null });

    const [rows] = await pool.query('SELECT track FROM verified_users WHERE discord_id = ?', [discordId]);
    const t = rows.length ? rows[0].track : null;
    res.json({ track: (t === 'piloto' || t === 'atc') ? t : null });
  } catch (err) {
    console.error('Error track/get:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

app.post('/api/track', requireAuth, async (req, res) => {
  try {
    const discordId = String(req.session.discordUser.id);
    const t = req.body && req.body.track;
    if (t !== 'piloto' && t !== 'atc') {
      return res.status(400).json({ error: 'Ruta no válida (piloto | atc)' });
    }

    // La ruta se elige/una vez aprobado el formulario (flujo LAN Academy)
    const status = await ultimoEstadoAcademy(discordId);
    if (status !== 'approved') {
      return res.status(403).json({ error: 'Tu formulario debe ser aprobado por el staff antes de elegir ruta.' });
    }

    const [upd] = await pool.query(
      'UPDATE verified_users SET track = ?, updated_at = NOW() WHERE discord_id = ?',
      [t, discordId]
    );
    if (!upd.affectedRows) {
      // por si la fila aún no existe (no debería pasar: se crea al iniciar sesión)
      await pool.query(
        `INSERT INTO verified_users (discord_id, track, fully_verified, updated_at)
         VALUES (?, ?, 0, NOW())
         ON DUPLICATE KEY UPDATE track = VALUES(track), updated_at = NOW()`,
        [discordId, t]
      );
    }

    console.log(`🧭 Ruta de ${discordId} → ${t}`);
    res.json({ success: true, track: t });
  } catch (err) {
    console.error('Error track/set:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// --- PANEL STAFF: formularios agrupados por fecha ---
app.get('/api/academy/panel', requireAuth, async (req, res) => {
  try {
    const discordId = String(req.session.discordUser.id);
    if (!(await esStaff(discordId))) {
      return res.status(403).json({ error: 'Sin permisos de staff' });
    }

    const [rows] = await pool.query(
      `SELECT s.id, s.discord_id, s.status, s.score, s.total, s.created_at,
              DATE_FORMAT(s.created_at, '%d/%m/%Y') AS fecha,
              u.discord_username, u.discord_global_name
       FROM academy_submissions s
       LEFT JOIN verified_users u ON u.discord_id = s.discord_id
       ORDER BY s.id DESC`
    );

    const mapa = {};
    rows.forEach(r => {
      if (!mapa[r.fecha]) mapa[r.fecha] = [];
      mapa[r.fecha].push({
        id: r.id,
        discord_id: r.discord_id,
        username: r.discord_global_name || r.discord_username || r.discord_id,
        status: r.status, // submitted | graded | approved | denied
        score: r.score,
        total: r.total
      });
    });

    const groups = Object.keys(mapa).map(fecha => ({
      fecha,
      count: mapa[fecha].length,
      items: mapa[fecha]
    }));

    res.json({ is_staff: true, groups });
  } catch (err) {
    console.error('Error academy/panel:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// --- Detalle de UN formulario (lo que respondió el user) ---
app.get('/api/academy/submission/:id', requireAuth, async (req, res) => {
  try {
    const discordId = String(req.session.discordUser.id);
    if (!(await esStaff(discordId))) {
      return res.status(403).json({ error: 'Sin permisos de staff' });
    }

    const [rows] = await pool.query(
      `SELECT s.*, u.discord_username, u.discord_global_name
       FROM academy_submissions s
       LEFT JOIN verified_users u ON u.discord_id = s.discord_id
       WHERE s.id = ?`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Formulario no encontrado' });

    const r = rows[0];
    let answers = {};
    try { answers = JSON.parse(r.answers); } catch (e) { answers = {}; }

    res.json({
      id: r.id,
      discord_id: r.discord_id,
      username: r.discord_global_name || r.discord_username || r.discord_id,
      status: r.status,
      score: r.score,
      total: r.total,
      answers,
      created_at: r.created_at
    });
  } catch (err) {
    console.error('Error academy/submission:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// --- CALIFICAR (cerradas automático + abiertas a elección del staff) ---
app.post('/api/academy/grade/:id', requireAuth, async (req, res) => {
  try {
    const discordId = String(req.session.discordUser.id);
    if (!(await esStaff(discordId))) {
      return res.status(403).json({ error: 'Sin permisos de staff' });
    }

    const [rows] = await pool.query('SELECT * FROM academy_submissions WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Formulario no encontrado' });
    const sub = rows[0];
    if (sub.status === 'approved' || sub.status === 'denied') {
      return res.status(409).json({ error: 'Este formulario ya fue cerrado.' });
    }

    let answers = {};
    try { answers = JSON.parse(sub.answers); } catch (e) { answers = {}; }
    const open = (req.body && req.body.open) ? req.body.open : {};

    // 1) Preguntas cerradas: se corrigen SOLAS
    let score = 0;
    let aciertos = 0;
    Object.keys(ACADEMY_KEY).forEach(q => {
      const userAns = String(answers[q] || '').trim().toLowerCase();
      const correcta = String(ACADEMY_KEY[q]).trim().toLowerCase();
      if (userAns && userAns === correcta) { score++; aciertos++; }
    });

    // 2) Preguntas abiertas: el staff elige buena (good) o mala (bad)
    let abiertasBien = 0;
    ACADEMY_ABIERTAS.forEach(q => {
      if (open[q] === 'good') { score++; abiertasBien++; }
    });

    await pool.query(
      `UPDATE academy_submissions
       SET status = 'graded', score = ?, staff_discord_id = ?, graded_at = NOW()
       WHERE id = ?`,
      [score, discordId, sub.id]
    );

    console.log(`✅ Academy: formulario #${sub.id} calificado → ${score}/20 (cerradas ${aciertos}/15, abiertas ${abiertasBien}/5)`);
    res.json({ success: true, score, total: 20, cerradas: aciertos, abiertas: abiertasBien });
  } catch (err) {
    console.error('Error academy/grade:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// --- DECISIÓN: aprobar (cambia rol) o denegar (puede rehacer + DM) ---
app.post('/api/academy/decision/:id', requireAuth, async (req, res) => {
  try {
    const discordId = String(req.session.discordUser.id);
    if (!(await esStaff(discordId))) {
      return res.status(403).json({ error: 'Sin permisos de staff' });
    }

    const action = req.body && req.body.action;
    if (action !== 'approve' && action !== 'deny') {
      return res.status(400).json({ error: 'Acción no válida' });
    }

    const [rows] = await pool.query(
      'SELECT id, discord_id, status, score, total FROM academy_submissions WHERE id = ?',
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Formulario no encontrado' });

    const sub = rows[0];
    if (sub.status !== 'graded') {
      return res.status(409).json({ error: 'Este formulario ya fue cerrado o aún no está calificado.' });
    }

    if (action === 'approve') {
      if (sub.score == null) {
        return res.status(400).json({ error: 'Primero califica el formulario.' });
      }
      // APROBADO → el bot le quita "Piloto En Formación" y le da "Piloto En Práctica"
      await pool.query(
        `UPDATE academy_submissions
         SET status = 'approved', role_action = 1, role_action_done = 0
         WHERE id = ?`,
        [sub.id]
      );
      console.log(`🎓 Academy: formulario #${sub.id} APROBADO → cambio de rol en cola`);
      res.json({ success: true, status: 'approved' });
    } else {
      // DENEGADO → el user ve el aviso en la web del formulario hasta que lo acepte
      //            y recibe un DM (si no se puede enviar, queda en cola para el bot)
      await pool.query(
        `UPDATE academy_submissions
         SET status = 'denied', denied_ack = 0, dm_pending = 1, denied_at = NOW()
         WHERE id = ?`,
        [sub.id]
      );

      const enviado = await enviarDM(sub.discord_id, mensajeDenegado(sub.score, sub.total));
      if (enviado) {
        await pool.query('UPDATE academy_submissions SET dm_pending = 0 WHERE id = ?', [sub.id]);
      }

      console.log(`🚫 Academy: formulario #${sub.id} DENEGADO | DM ${enviado ? 'enviado' : 'pendiente'}`);
      res.json({ success: true, status: 'denied', dm_sent: enviado });
    }
  } catch (err) {
    console.error('Error academy/decision:', err.message);
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
  if (!code) return res.status(400).send('No se proporcionó código de Discord');

  try {
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

    if (!tokenResponse.ok) throw new Error('Error obteniendo token de Discord');

    const tokenData = await tokenResponse.json();

    const userResponse = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `${tokenData.token_type} ${tokenData.access_token}` }
    });

    if (!userResponse.ok) throw new Error('Error obteniendo usuario de Discord');

    const user = await userResponse.json();

    req.session.discordUser = {
      id: user.id,
      username: user.username,
      global_name: user.global_name,
      avatar: user.avatar,
      fully_verified: 0
    };

    const [existing] = await pool.query(
      'SELECT id, fully_verified, roblox_id, roblox_username, roblox_avatar FROM verified_users WHERE discord_id = ? ORDER BY id ASC',
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
      // Mejor registro del usuario (aunque haya filas duplicadas viejas)
      const estado = await obtenerEstadoVerificado(user.id);
      req.session.discordUser.fully_verified = estado.fully_verified ? 1 : 0;
      req.session.discordUser.roblox_id = estado.roblox_id || null;
      req.session.discordUser.roblox_username = estado.roblox_username || null;
      req.session.discordUser.roblox_avatar = estado.roblox_avatar || null;
    }

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
    return res.status(500).send('ROBLOX_CLIENT_ID no configurado (app en revisión)');
  }
  const redirectUri = encodeURIComponent('https://latinaviationnetwork.com/auth/roblox/callback');
  const state = encodeURIComponent('guild::' + req.session.discordUser.id);
  const scope = encodeURIComponent('openid profile');
  // URL base oficial: https://apis.roblox.com/oauth  (¡NO /oauth2/ !)
  const url = `https://apis.roblox.com/oauth/v1/authorize?client_id=${ROBLOX_CLIENT_ID}&response_type=code&redirect_uri=${redirectUri}&scope=${scope}&state=${state}`;
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
    const tokenResponse = await fetch('https://apis.roblox.com/oauth/v1/token', {
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
      throw new Error('Roblox rechazó el intercambio de código: ' + errText.slice(0, 300));
    }

    const tokenData = await tokenResponse.json();

    // Endpoint oficial de userinfo: https://apis.roblox.com/oauth/v1/userinfo
    const userResponse = await fetch('https://apis.roblox.com/oauth/v1/userinfo', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });

    if (!userResponse.ok) throw new Error('Error obteniendo perfil de Roblox');

    const info = await userResponse.json();
    const robloxUser = {
      id: info.sub,
      name: info.preferred_username || info.name || ('user_' + info.sub)
    };
    const avatarUrl = info.picture ||
      `https://www.roblox.com/headshot-thumbnail/image?userId=${info.sub}&width=420&height=420&format=png`;

    // UPDATE primero; si no había fila, se crea (si no, el Roblox nunca se guardaba)
    const [upd] = await pool.query(
      `UPDATE verified_users
       SET roblox_id = ?, roblox_username = ?, roblox_avatar = ?, roblox_verified_at = NOW(), updated_at = NOW()
       WHERE discord_id = ?`,
      [robloxUser.id, robloxUser.name, avatarUrl, discordId]
    );
    if (upd.affectedRows === 0) {
      await pool.query(
        `INSERT INTO verified_users (discord_id, discord_username, discord_global_name, discord_avatar, discord_verified_at, roblox_id, roblox_username, roblox_avatar, fully_verified, updated_at)
         VALUES (?, ?, ?, ?, NOW(), ?, ?, ?, 0, NOW())`,
        [discordId, req.session.discordUser.username, req.session.discordUser.global_name, req.session.discordUser.avatar,
         robloxUser.id, robloxUser.name, avatarUrl]
      );
    }

    req.session.discordUser.roblox_id = robloxUser.id;
    req.session.discordUser.roblox_username = robloxUser.name;
    req.session.discordUser.roblox_avatar = avatarUrl;

    res.redirect('/verificacion.html?step=3&verified=roblox');
  } catch (err) {
    console.error('Error Roblox callback:', err.message);
    res.status(500).send('Error verificando Roblox: ' + err.message);
  }
});

// --- Marcar verificación completa (paso 3) ---
// Roblox es OBLIGATORIO (la app ya está aprobada) y se escribe sin duplicar filas
app.post('/api/verify-complete', requireAuth, async (req, res) => {
  try {
    const discordId = req.session.discordUser.id;
    const estado = await obtenerEstadoVerificado(discordId);

    if (!estado.roblox_id) {
      return res.status(400).json({ error: 'Debes conectar tu cuenta de Roblox para completar la verificación.' });
    }

    // 1) UPDATE primero (no crea filas nuevas)
    const [upd] = await pool.query(
      'UPDATE verified_users SET fully_verified = 1, updated_at = NOW() WHERE discord_id = ?',
      [discordId]
    );

    // 2) Si no existía ninguna fila, recién ahí se inserta
    if (upd.affectedRows === 0) {
      await pool.query(
        `INSERT INTO verified_users (discord_id, discord_username, discord_global_name, discord_avatar, discord_verified_at, roblox_id, roblox_username, roblox_avatar, fully_verified, updated_at)
         VALUES (?, ?, ?, ?, NOW(), ?, ?, ?, 1, NOW())`,
        [discordId, req.session.discordUser.username, req.session.discordUser.global_name, req.session.discordUser.avatar,
         estado.roblox_id, estado.roblox_username, estado.roblox_avatar]
      );
    }

    req.session.discordUser.fully_verified = 1;

    req.session.save((err) => {
      if (err) {
        console.error('Error guardando sesión:', err.message);
        return res.json({ success: true, redirect: '/dashboard' });
      }
      res.json({ success: true, redirect: '/dashboard' });
    });
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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Servidor en http://0.0.0.0:${PORT}`);
});
