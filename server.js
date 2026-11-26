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
console.log('📋 DISCORD_CLIENT_ID:', process.env.DISCORD_CLIENT_ID ? `✅ (${process.env.DISCORD_CLIENT_ID})` : '❌ FALTANTE');
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
  if (req.path === '/dashboard.html' || req.path === '/dashboard-aviacion.html' || req.path === '/planes-de-vuelo.html' || req.path === '/atc-operations.html' || req.path === '/atc-clearance.html' || req.path === '/cartas-de-vuelo.html') {
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
    // Marca para que el bot asigne el rol de formación al elegir ruta
    try {
      await pool.query('ALTER TABLE verified_users ADD COLUMN track_role_done TINYINT NOT NULL DEFAULT 0');
    } catch (e) { if (e.code !== 'ER_DUP_FIELDNAME') console.error('Error columna track_role_done:', e.message); }
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
    // Las peticiones API reciben 401 (para que el JS lo detecte sin seguir redirecciones);
    // las navegaciones normales siguen yendo al login.
    if (req.path.startsWith('/api/') || req.xhr) {
      return res.status(401).json({ error: 'No autenticado' });
    }
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

// ============================================
// Exámenes LAN Academy — UNO POR RUTA
//   piloto →20 preguntas (15 cerradas ×1 +5 abiertas ×1)
//   atc    →15 preguntas (10 cerradas ×1 +5 abiertas ×2) =20 pts, mínimo16
// ============================================
const EXAMENES = {
  piloto: {
    nombre: 'Formulario Piloto LAN Academy',
    totalPreguntas: 20,
    total: 20,
    minAprobar: 16,
    // Respuestas correctas de las preguntas CERRADAS (15)
    cerradas: {
      1: 'B', 2: 'C', 3: 'Falso', 4: 'B',
      6: 'B', 7: 'C', 8: 'Verdadero', 9: 'B',
      11: 'B', 12: 'Verdadero', 13: 'B', 15: 'B',
      16: 'B', 18: 'B', 19: 'Verdadero'
    },
    // Preguntas ABIERTAS (las califica el staff: good = buena, bad = mala)
    abiertas: [5, 10, 14, 17, 20],
    puntosCerrada: 1,
    puntosAbierta: 1
  },
  atc: {
    nombre: 'Formulario ATC LAN Academy',
    totalPreguntas: 15,
    total: 20,
    minAprobar: 16,
    // Evaluación teórica ATC —10 de selección múltiple
    cerradas: {
      1: 'B', 2: 'A', 3: 'B', 4: 'C', 5: 'C',
      6: 'B', 7: 'B', 8: 'C', 9: 'B', 10: 'A'
    },
    //5 abiertas (desarrollo) →2 puntos cada una
    abiertas: [11, 12, 13, 14, 15],
    puntosCerrada: 1,
    puntosAbierta: 2
  }
};
// Compatibilidad con el código viejo (examen piloto)
const ACADEMY_KEY = EXAMENES.piloto.cerradas;
const ACADEMY_ABIERTAS = EXAMENES.piloto.abiertas;

// Devuelve el examen que le corresponde al usuario según su ruta
async function examenDe(discordId) {
  const track = await obtenerTrack(discordId);
  return EXAMENES[track === 'atc' ? 'atc' : 'piloto'];
}

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

    // --------------------------------------------
    // PLANES DE VUELO (Flight Planning)
    //   - El piloto crea/envía/cancela sus planes
    //   - El ATC (rol 1555512718046404609) los revisa, asigna estado y squawk
    //   - Estados: draft | pending | approved | active | finished | rejected | cancelled
    // --------------------------------------------
    await pool.query(`
      CREATE TABLE IF NOT EXISTS flight_plans (
        id INT AUTO_INCREMENT PRIMARY KEY,
        discord_id VARCHAR(20) NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'draft',
        flight_rules VARCHAR(10) NOT NULL DEFAULT 'IFR',
        departure VARCHAR(12) NOT NULL,
        destination VARCHAR(12) NOT NULL,
        airline VARCHAR(60) DEFAULT NULL,
        registration VARCHAR(20) DEFAULT NULL,
        flight_number VARCHAR(20) DEFAULT NULL,
        aircraft VARCHAR(12) NOT NULL,
        cruise_altitude VARCHAR(20) DEFAULT NULL,
        'alternate' VARCHAR(12) DEFAULT NULL,
        squawk VARCHAR(4) DEFAULT NULL,
        rejection_reason TEXT DEFAULT NULL,
        reviewed_by VARCHAR(20) DEFAULT NULL,
        reviewed_at DATETIME DEFAULT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        KEY idx_fp_discord (discord_id),
        KEY idx_fp_status (status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // Columnas ATC Operations (Flight Strips + transferencias entre posiciones)
    const columnasAtc = [
      'ALTER TABLE flight_plans ADD COLUMN atc_stage VARCHAR(12) DEFAULT NULL',
      'ALTER TABLE flight_plans ADD COLUMN flight_kind VARCHAR(4) DEFAULT NULL',
      'ALTER TABLE flight_plans ADD COLUMN runway VARCHAR(8) DEFAULT NULL',
      'ALTER TABLE flight_plans ADD COLUMN sid VARCHAR(40) DEFAULT NULL',
      'ALTER TABLE flight_plans ADD COLUMN squawk_validated TINYINT NOT NULL DEFAULT 0',
      'ALTER TABLE flight_plans ADD COLUMN atc_controller_id VARCHAR(20) DEFAULT NULL',
      'ALTER TABLE flight_plans ADD COLUMN cleared_at DATETIME DEFAULT NULL',
      'ALTER TABLE flight_plans ADD COLUMN taxi_at DATETIME DEFAULT NULL',
      'ALTER TABLE flight_plans ADD COLUMN finished_at DATETIME DEFAULT NULL'
    ];
    for (const sql of columnasAtc) {
      try { await pool.query(sql); }
      catch (e) { if (e.code !== 'ER_DUP_FIELDNAME') console.error('Error columna ATC:', e.message); }
    }

    // Aeropuertos ATC (los que tienen vuelos + los del spec)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS atc_airports (
        code VARCHAR(8) NOT NULL PRIMARY KEY,
        name VARCHAR(120) NOT NULL,
        active TINYINT NOT NULL DEFAULT 1
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    const aeropuertosIniciales = [
      ['SKBO','El Dorado International'], ['SKRG','José María Córdova'], ['SKIB','Perales'],
      ['EGFF','Cardiff Airport'], ['EGKK','London Gatwick'], ['EGLC','London City'],
      ['LCLK','Larnaca International'], ['LCPH','Paphos International'], ['LCRA','RAF Akrotiri'],
      ['LPMA','Madeira Airport'], ['MDAB','Arroyo Barril International'], ['MDCR','Cabo Rojo'],
      ['MDPC','Punta Cana International'], ['MDST','Cibao International'],
      ['MTCA','Cap-Haitien International'], ['PAFA','Fairbanks International']
    ];
    for (const [code, name] of aeropuertosIniciales) {
      await pool.query('INSERT IGNORE INTO atc_airports (code, name) VALUES (?, ?)', [code, name]);
    }

    // Posiciones ATC por aeropuerto (DEL/GND/TWR) — un controlador por posición
    await pool.query(`
      CREATE TABLE IF NOT EXISTS atc_positions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        airport_code VARCHAR(8) NOT NULL,
        position VARCHAR(4) NOT NULL,
        controller_id VARCHAR(20) DEFAULT NULL,
        controller_name VARCHAR(120) DEFAULT NULL,
        session_start DATETIME DEFAULT NULL,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_atc_pos (airport_code, position)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    for (const code of aeropuertosIniciales.map(a => a[0])) {
      for (const pos of ['DEL','GND','TWR']) {
        await pool.query('INSERT IGNORE INTO atc_positions (airport_code, position) VALUES (?, ?)', [code, pos]);
      }
    }

    // Registro de operaciones ATC
    await pool.query(`
      CREATE TABLE IF NOT EXISTS atc_operations (
        id INT AUTO_INCREMENT PRIMARY KEY,
        airport_code VARCHAR(8) NOT NULL,
        callsign VARCHAR(40) DEFAULT NULL,
        position VARCHAR(4) DEFAULT NULL,
        action VARCHAR(80) NOT NULL,
        controller_id VARCHAR(20) DEFAULT NULL,
        controller_name VARCHAR(120) DEFAULT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        KEY idx_atc_ops_airport (airport_code)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // Notificaciones internas
    await pool.query(`
      CREATE TABLE IF NOT EXISTS lan_notifications (
        id INT AUTO_INCREMENT PRIMARY KEY,
        discord_id VARCHAR(20) NOT NULL,
        title VARCHAR(120) NOT NULL,
        message VARCHAR(500) NOT NULL,
        icon VARCHAR(20) DEFAULT 'plane',
        read_at DATETIME DEFAULT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        KEY idx_notif_user (discord_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    console.log('🗂️ Tablas user_roles + academy_submissions + flight_plans + ATC listas.');
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

// --- Página de PLANES DE VUELO (SOLO PILOTOS con formulario aprobado) ---
app.get('/dashboard/planes-de-vuelo', requireVerificado, async (req, res) => {
  try {
    const discordId = String(req.session.discordUser.id);
    if (!(await academyAprobado(discordId))) {
      return res.redirect('/dashboard');   // sin aprobación no entra
    }
    // ⚠️ Ya NO redirigimos a ATC aunque tenga el rol: si el usuario eligió
    // "Planes de Vuelo", debe ver SU página de piloto (puede tener ambos roles).
    res.sendFile(path.join(__dirname, 'public', 'planes-de-vuelo.html'));
  } catch (err) {
    console.error('Error planes-de-vuelo:', err.message);
    res.redirect('/dashboard');
  }
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
    const track = await obtenerTrack(discordId);
    const examen = EXAMENES[track === 'atc' ? 'atc' : 'piloto'];

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
      is_atc: await esAtc(discordId),                   // Controlador Aéreo (rol 1555512718046404609)
      instructor_roles: ids.filter(r => r === '1555512949391495218' || r === '1556059095277109348'),
      roles: ids,   // todos los roles del usuario (para mostrar ambos accesos si tiene Piloto + ATC)
      track,                                          // 'piloto' | 'atc' | null (aún no eligió)
      exam: {                                         // examen que le corresponde según su ruta
        key: track === 'atc' ? 'atc' : 'piloto',
        nombre: examen.nombre,
        total: examen.total,
        totalPreguntas: examen.totalPreguntas,
        minAprobar: examen.minAprobar
      },
      status: last ? last.status : 'none',   // none | submitted | graded | approved | denied
      score: last && last.score != null ? last.score : null,
      total: last && last.total != null ? last.total : examen.total,
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
    const examen = await examenDe(discordId);
    const faltantes = [];
    for (let i = 1; i <= examen.totalPreguntas; i++) {
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
         VALUES (?, ?, 'submitted', ?)`,
        [discordId, JSON.stringify(answers), examen.total]
      );
      console.log(`📝 Academy: formulario recibido de ${discordId} (${examen.nombre})`);
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

// --- RUTA: Piloto o ATC (se elige UNA vez, en el overlay de bienvenida) ---
// Ya NO depende de la aprobación: es la primera cosa que hace el usuario
// al entrar. Después de elegirla, no se puede cambiar (no hay "Cambiar ruta").
async function obtenerTrack(discordId) {
  const [rows] = await pool.query('SELECT track FROM verified_users WHERE discord_id = ?', [discordId]);
  const t = rows.length ? rows[0].track : null;
  return (t === 'piloto' || t === 'atc') ? t : null;
}

app.get('/api/track', requireAuth, async (req, res) => {
  try {
    const discordId = String(req.session.discordUser.id);
    res.json({ track: await obtenerTrack(discordId) });
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

    // Solo se puede elegir UNA vez (si ya hay ruta válida, no se cambia)
    const actual = await obtenerTrack(discordId);
    if (actual) {
      return res.status(409).json({ error: 'Ya elegiste tu ruta; no se puede cambiar.' });
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

// ============================================
// PLANES DE VUELO (Flight Planning)
//   piloto → crea / envía / cancela / consulta los suyos
//   ATC (1555512718046404609) o staff → ve todos, asigna
//   estado y squawk (aleatorio de4 dígitos, nunca inicia con7)
// ============================================
const ROL_ATC_CONTROLADOR = '1555512718046404609';
const ESTADOS_PLAN = ['draft', 'pending', 'approved', 'active', 'finished', 'rejected', 'cancelled'];

// Squawk de4 dígitos: el PRIMERO nunca puede ser7 (ej:3457,1328)
function generarSquawk() {
  const primeros = ['0', '1', '2', '3', '4', '5', '6', '8', '9'];
  let s = primeros[Math.floor(Math.random() * primeros.length)];
  for (let i = 0; i < 3; i++) s += Math.floor(Math.random() * 10);
  return s;
}

async function esAtc(discordId) {
  const ids = await obtenerRangosIds(discordId);
  return ids.includes(ROL_ATC_CONTROLADOR) || STAFF_ROLES.some(r => ids.includes(r));
}

// El formulario de admisión debe estar APROBADO para usar planes de vuelo
async function academyAprobado(discordId) {
  const [rows] = await pool.query(
    'SELECT status FROM academy_submissions WHERE discord_id = ? ORDER BY id DESC LIMIT 1',
    [discordId]
  );
  return rows.length ? rows[0].status === 'approved' : false;
}

async function requiereAprobacion(req, res) {
  const discordId = String(req.session.discordUser.id);
  if (!(await academyAprobado(discordId))) {
    res.status(403).json({ error: 'Primero debes completar y aprobar tu formulario de admisión.' });
    return null;
  }
  return discordId;
}

function planPublico(r, conSquawk) {
  return {
    id: r.id,
    discord_id: r.discord_id,
    username: r.discord_global_name || r.discord_username || r.discord_id,
    status: r.status,
    flight_rules: r.flight_rules,
    departure: r.departure,
    destination: r.destination,
    airline: r.airline || '',
    registration: r.registration || '',
    flight_number: r.flight_number || '',
    aircraft: r.aircraft,
    cruise_altitude: r.cruise_altitude || '',
    alternate: r.alternate || '',
    // 🔒 Squawk: SOLO ATC. El piloto nunca lo ve (debe digitarlo en Clearance).
    squawk: conSquawk ? (r.squawk || null) : null,
    has_squawk: !!r.squawk,
    squawk_validated: !!r.squawk_validated,
    atc_stage: r.atc_stage || null,
    atc_controller_id: r.atc_controller_id || null,
    runway: r.runway || null,
    sid: r.sid || null,
    flight_kind: r.flight_kind || null,
    cleared_at: r.cleared_at || null,
    taxi_at: r.taxi_at || null,
    finished_at: r.finished_at || null,
    rejection_reason: r.rejection_reason || null,
    created_at: r.created_at,
    updated_at: r.updated_at
  };
}

// Crear notificación interna (DM lo hace el bot en segundo plano)
async function notificar(discordId, title, message, icon) {
  try {
    await pool.query(
      'INSERT INTO lan_notifications (discord_id, title, message, icon) VALUES (?, ?, ?, ?)',
      [discordId, title, message, icon || 'plane']
    );
  } catch (e) { console.error('Error notificando:', e.message); }
}

// Registrar operación ATC
async function registrarOperacion(airport, callsign, position, action, controllerId, controllerName) {
  try {
    await pool.query(
      `INSERT INTO atc_operations (airport_code, callsign, position, action, controller_id, controller_name)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [airport, callsign || null, position || null, action, controllerId || null, controllerName || null]
    );
  } catch (e) { console.error('Error registrando operación ATC:', e.message); }
}

// --- Planes ACTIVOS/APROBADOS: visibles para cualquier usuario aprobado ---
app.get('/api/flight-plans/active', requireAuth, async (req, res) => {
  try {
    const discordId = await requiereAprobacion(req, res);
    if (!discordId) return;
    const [rows] = await pool.query(
      `SELECT s.*, u.discord_username, u.discord_global_name
       FROM flight_plans s
       LEFT JOIN verified_users u ON u.discord_id = s.discord_id
       WHERE s.status IN ('approved','active','pending')
       ORDER BY FIELD(s.status,'active','approved','pending'), s.id DESC`
    );
    res.json({ plans: rows.map(r => planPublico(r, false)) });
  } catch (err) {
    console.error('Error flight-plans/active:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// --- Mis planes de vuelo (piloto) ---
app.get('/api/flight-plans', requireAuth, async (req, res) => {
  try {
    const discordId = await requiereAprobacion(req, res);
    if (!discordId) return;
    const [rows] = await pool.query(
      `SELECT s.*, u.discord_username, u.discord_global_name
       FROM flight_plans s
       LEFT JOIN verified_users u ON u.discord_id = s.discord_id
       WHERE s.discord_id = ?
       ORDER BY s.id DESC`,
      [discordId]
    );
    res.json({ plans: rows.map(r => planPublico(r, false)) });
  } catch (err) {
    console.error('Error flight-plans/list:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// --- Crear plan (draft) o enviarlo directo (pending) ---
function leerCuerpoPlan(body) {
  const b = body || {};
  const limpio = v => (v == null ? '' : String(v).trim().toUpperCase());
  const plan = {
    flight_rules: (String(b.flight_rules || 'IFR').toUpperCase() === 'VFR') ? 'VFR' : 'IFR',
    departure: limpio(b.departure),
    destination: limpio(b.destination),
    airline: (b.airline == null ? '' : String(b.airline).trim()),
    registration: limpio(b.registration),
    flight_number: limpio(b.flight_number),
    aircraft: limpio(b.aircraft),
    cruise_altitude: (b.cruise_altitude == null ? '' : String(b.cruise_altitude).trim()),
    alternate: limpio(b.alternate)
  };
  const errores = [];
  if (!/^[A-Z]{4}$/.test(plan.departure)) errores.push('Salida (4 letras ICAO, ej. EGKK)');
  if (!/^[A-Z]{4}$/.test(plan.destination)) errores.push('Destino (4 letras ICAO, ej. MDPC)');
  if (plan.departure && plan.departure === plan.destination) errores.push('Salida y destino deben ser distintos');
  if (!plan.aircraft) errores.push('Aeronave');
  if (plan.aircraft && plan.aircraft.length > 12) errores.push('Aeronave demasiado larga');
  if (plan.alternate && !/^[A-Z]{4}$/.test(plan.alternate)) errores.push('Alternate (4 letras ICAO)');
  if (plan.registration.length > 20) errores.push('Matrícula demasiado larga');
  if (plan.flight_number.length > 20) errores.push('Número de vuelo demasiado largo');
  return { plan, errores };
}

app.post('/api/flight-plans', requireAuth, async (req, res) => {
  try {
    const discordId = await requiereAprobacion(req, res);
    if (!discordId) return;

    const { plan, errores } = leerCuerpoPlan(req.body);
    if (errores.length) return res.status(400).json({ error: 'Revisa: ' + errores.join(' · ') });

    const enviar = !!(req.body && req.body.enviar);
    const status = enviar ? 'pending' : 'draft';
    // 🔒 Squawk nace AL ENVIAR (solo lo ve ATC). Nunca se crea en borrador.
    let squawk = null;
    if (enviar) {
      squawk = generarSquawk();
      for (let i = 0; i < 10; i++) {
        const [dupe] = await pool.query('SELECT id FROM flight_plans WHERE squawk = ?', [squawk]);
        if (!dupe.length) break;
        squawk = generarSquawk();
      }
    }
    const [r] = await pool.query(
      `INSERT INTO flight_plans
        (discord_id, status, flight_rules, departure, destination, airline,
         registration, flight_number, aircraft, cruise_altitude, alternate,
         squawk, atc_stage, flight_kind)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [discordId, status, plan.flight_rules, plan.departure, plan.destination, plan.airline,
       plan.registration, plan.flight_number, plan.aircraft, plan.cruise_altitude, plan.alternate,
       squawk, enviar ? 'DEL' : null, enviar ? 'DEP' : null]
    );
    if (enviar) {
      await registrarOperacion(plan.departure, plan.flight_number || ('#' + r.insertId), 'DEL', 'Plan recibido en Delivery', discordId, null);
      await notificar(discordId, 'Tu plan de vuelo ha sido recibido',
        `${plan.departure} → ${plan.destination} está en espera de autorización de Delivery.`, 'plane');
    }
    console.log(`✈️ Plan #${r.insertId} de ${discordId} → ${status} (${plan.departure} → ${plan.destination})`);
    res.json({ success: true, id: r.insertId, status });
  } catch (err) {
    console.error('Error flight-plans/create:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// --- Editar (solo borradores, rechazados o cancelados) y/o reenviar ---
app.put('/api/flight-plans/:id', requireAuth, async (req, res) => {
  try {
    const discordId = await requiereAprobacion(req, res);
    if (!discordId) return;

    const [rows] = await pool.query('SELECT * FROM flight_plans WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Plan no encontrado' });
    const fp = rows[0];
    if (fp.discord_id !== discordId) return res.status(403).json({ error: 'No es tu plan' });
    if (!['draft', 'cancelled'].includes(fp.status)) {
      return res.status(409).json({ error: 'Este plan ya no se puede editar: los planes rechazados, aprobados, activos o finalizados son definitivos.' });
    }

    const { plan, errores } = leerCuerpoPlan(req.body);
    if (errores.length) return res.status(400).json({ error: 'Revisa: ' + errores.join(' · ') });

    const enviar = !!(req.body && req.body.enviar);
    const status = enviar ? 'pending' : 'draft';
    let squawk = fp.squawk;
    if (enviar && !squawk) {
      squawk = generarSquawk();
      for (let i = 0; i < 10; i++) {
        const [dupe] = await pool.query('SELECT id FROM flight_plans WHERE squawk = ? AND id != ?', [squawk, fp.id]);
        if (!dupe.length) break;
        squawk = generarSquawk();
      }
    }
    await pool.query(
      `UPDATE flight_plans
       SET status = ?, flight_rules = ?, departure = ?, destination = ?, airline = ?,
           registration = ?, flight_number = ?, aircraft = ?, cruise_altitude = ?,
           alternate = ?, rejection_reason = NULL,
           squawk = ?, squawk_validated = 0, atc_stage = ?, flight_kind = 'DEP', updated_at = NOW()
       WHERE id = ?`,
      [status, plan.flight_rules, plan.departure, plan.destination, plan.airline,
       plan.registration, plan.flight_number, plan.aircraft, plan.cruise_altitude,
       plan.alternate, squawk, enviar ? 'DEL' : null, fp.id]
    );
    if (enviar) await notificar(discordId, 'Tu plan de vuelo ha sido recibido',
      `${plan.departure} → ${plan.destination} está en espera de autorización de Delivery.`, 'plane');
    res.json({ success: true, status });
  } catch (err) {
    console.error('Error flight-plans/update:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// --- Enviar a revisión (borrador → pendiente) ---
app.post('/api/flight-plans/:id/submit', requireAuth, async (req, res) => {
  try {
    const discordId = await requiereAprobacion(req, res);
    if (!discordId) return;
    const [rows] = await pool.query('SELECT * FROM flight_plans WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Plan no encontrado' });
    const fp = rows[0];
    if (fp.discord_id !== discordId) return res.status(403).json({ error: 'No es tu plan' });
    if (!['draft', 'cancelled'].includes(fp.status)) {
      return res.status(409).json({ error: 'Este plan ya no se puede reenviar: los planes rechazados o finalizados son definitivos.' });
    }
    await pool.query(
      `UPDATE flight_plans SET status = 'pending', rejection_reason = NULL, updated_at = NOW() WHERE id = ?`,
      [fp.id]
    );
    res.json({ success: true, status: 'pending' });
  } catch (err) {
    console.error('Error flight-plans/submit:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// --- Cancelar un plan pendiente (piloto) ---
app.post('/api/flight-plans/:id/cancel', requireAuth, async (req, res) => {
  try {
    const discordId = await requiereAprobacion(req, res);
    if (!discordId) return;
    const [rows] = await pool.query('SELECT * FROM flight_plans WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Plan no encontrado' });
    const fp = rows[0];
    if (fp.discord_id !== discordId) return res.status(403).json({ error: 'No es tu plan' });
    if (fp.status !== 'pending') {
      return res.status(409).json({ error: 'Solo se pueden cancelar planes pendientes.' });
    }
    await pool.query(
      `UPDATE flight_plans SET status = 'cancelled', updated_at = NOW() WHERE id = ?`,
      [fp.id]
    );
    console.log(`✈️ Plan #${fp.id} cancelado por ${discordId}`);
    res.json({ success: true, status: 'cancelled' });
  } catch (err) {
    console.error('Error flight-plans/cancel:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// --- Panel ATC/staff: TODOS los planes de vuelo ---
app.get('/api/flight-plans/staff', requireAuth, async (req, res) => {
  try {
    const discordId = String(req.session.discordUser.id);
    if (!(await esAtc(discordId))) {
      return res.status(403).json({ error: 'Sin permisos de Controlador Aéreo' });
    }
    const [rows] = await pool.query(
      `SELECT s.*, u.discord_username, u.discord_global_name
       FROM flight_plans s
       LEFT JOIN verified_users u ON u.discord_id = s.discord_id
       ORDER BY FIELD(s.status, 'pending', 'approved', 'active', 'rejected', 'draft', 'cancelled', 'finished'), s.id DESC`
    );
    res.json({ plans: rows.map(r => planPublico(r, true)) });   // ATC SÍ ve el squawk
  } catch (err) {
    console.error('Error flight-plans/staff:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// --- Decisión ATC: aprobar (asigna squawk) o rechazar (con motivo) ---
app.post('/api/flight-plans/:id/decision', requireAuth, async (req, res) => {
  try {
    const discordId = String(req.session.discordUser.id);
    if (!(await esAtc(discordId))) {
      return res.status(403).json({ error: 'Sin permisos de Controlador Aéreo' });
    }
    const action = req.body && req.body.action;
    if (action !== 'approve' && action !== 'reject') {
      return res.status(400).json({ error: 'Acción no válida' });
    }

    const [rows] = await pool.query('SELECT * FROM flight_plans WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Plan no encontrado' });
    const fp = rows[0];
    if (fp.status !== 'pending') {
      return res.status(409).json({ error: 'Este plan no está pendiente de revisión.' });
    }

    if (action === 'approve') {
      // Squawk aleatorio de4 dígitos SIN inicial7
      let squawk = generarSquawk();
      for (let i = 0; i < 10; i++) {
        const [dupe] = await pool.query(
          'SELECT id FROM flight_plans WHERE squawk = ? AND id != ?',
          [squawk, fp.id]
        );
        if (!dupe.length) break;
        squawk = generarSquawk();
      }
      await pool.query(
        `UPDATE flight_plans
         SET status = 'approved', squawk = ?, rejection_reason = NULL,
             reviewed_by = ?, reviewed_at = NOW(), updated_at = NOW()
         WHERE id = ?`,
        [squawk, discordId, fp.id]
      );
      console.log(`✅ Plan #${fp.id} APROBADO por ${discordId} → squawk ${squawk}`);
      res.json({ success: true, status: 'approved', squawk });
    } else {
      const motivo = (req.body && req.body.reason ? String(req.body.reason).trim() : '');
      if (!motivo) return res.status(400).json({ error: 'Indica el motivo del rechazo.' });
      await pool.query(
        `UPDATE flight_plans
         SET status = 'rejected', rejection_reason = ?, squawk = NULL,
             reviewed_by = ?, reviewed_at = NOW(), updated_at = NOW()
         WHERE id = ?`,
        [motivo, discordId, fp.id]
      );
      console.log(`🚫 Plan #${fp.id} RECHAZADO por ${discordId}: ${motivo}`);
      res.json({ success: true, status: 'rejected' });
    }
  } catch (err) {
    console.error('Error flight-plans/decision:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// --- Cambiar estado del vuelo (ATC): cualquier estado + squawk al aprobar ---
app.post('/api/flight-plans/:id/status', requireAuth, async (req, res) => {
  try {
    const discordId = String(req.session.discordUser.id);
    if (!(await esAtc(discordId))) {
      return res.status(403).json({ error: 'Sin permisos de Controlador Aéreo' });
    }
    const nuevo = req.body && req.body.status;
    if (!ESTADOS_PLAN.includes(nuevo)) {
      return res.status(400).json({ error: 'Estado no válido' });
    }
    const [rows] = await pool.query('SELECT * FROM flight_plans WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Plan no encontrado' });
    const fp = rows[0];

    // 🔒 Planes definitivos: rechazados o finalizados NO se pueden modificar
    if (['rejected', 'finished'].includes(fp.status)) {
      return res.status(409).json({ error: 'Este plan es definitivo (rechazado o finalizado) y ya no se puede modificar.' });
    }

    // Aprobar → asigna squawk aleatorio (4 dígitos, nunca inicia con 7) si no tiene
    let squawk = fp.squawk;
    let motivo = fp.rejection_reason;
    if (nuevo === 'approved') {
      if (!squawk) {
        squawk = generarSquawk();
        for (let i = 0; i < 10; i++) {
          const [dupe] = await pool.query('SELECT id FROM flight_plans WHERE squawk = ? AND id != ?', [squawk, fp.id]);
          if (!dupe.length) break;
          squawk = generarSquawk();
        }
      }
      motivo = null;
    } else if (nuevo === 'rejected') {
      const reason = (req.body && req.body.reason ? String(req.body.reason).trim() : '');
      if (!reason) return res.status(400).json({ error: 'Indica el motivo del rechazo.' });
      motivo = reason;
      squawk = null;
    }
    if (['active', 'finished'].includes(nuevo) && !squawk) {
      return res.status(409).json({ error: 'Este plan aún no tiene squawk asignado.' });
    }

    await pool.query(
      `UPDATE flight_plans
       SET status = ?, squawk = ?, rejection_reason = ?, reviewed_by = ?, reviewed_at = NOW(), updated_at = NOW()
       WHERE id = ?`,
      [nuevo, squawk, motivo, discordId, fp.id]
    );
    console.log(`🎛️ Plan #${fp.id} → ${nuevo} por ${discordId}${squawk ? ' · squawk ' + squawk : ''}`);
    res.json({ success: true, status: nuevo, squawk });
  } catch (err) {
    console.error('Error flight-plans/status:', err.message);
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
              u.discord_username, u.discord_global_name, u.track
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
        total: r.total,
        track: (r.track === 'atc' || r.track === 'piloto') ? r.track : 'piloto'
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
    const trackSub = await obtenerTrack(r.discord_id);

    res.json({
      id: r.id,
      discord_id: r.discord_id,
      username: r.discord_global_name || r.discord_username || r.discord_id,
      status: r.status,
      score: r.score,
      total: r.total,
      answers,
      exam_key: trackSub === 'atc' ? 'atc' : 'piloto',   // banco de preguntas que corresponde
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
    const examen = await examenDe(sub.discord_id);

    // 1) Preguntas cerradas: se corrigen SOLAS
    let score = 0;
    let aciertos = 0;
    Object.keys(examen.cerradas).forEach(q => {
      const userAns = String(answers[q] || '').trim().toLowerCase();
      const correcta = String(examen.cerradas[q]).trim().toLowerCase();
      if (userAns && userAns === correcta) { score += examen.puntosCerrada; aciertos++; }
    });

    // 2) Preguntas abiertas: el staff elige buena (good) o mala (bad)
    let abiertasBien = 0;
    examen.abiertas.forEach(q => {
      if (open[q] === 'good') { score += examen.puntosAbierta; abiertasBien++; }
    });

    await pool.query(
      `UPDATE academy_submissions
       SET status = 'graded', score = ?, staff_discord_id = ?, graded_at = NOW()
       WHERE id = ?`,
      [score, discordId, sub.id]
    );

    console.log(`✅ Academy: formulario #${sub.id} (${examen.nombre}) calificado → ${score}/${examen.total} (cerradas ${aciertos}/${Object.keys(examen.cerradas).length}, abiertas ${abiertasBien}/${examen.abiertas.length})`);
    res.json({ success: true, score, total: examen.total, cerradas: aciertos, abiertas: abiertasBien });
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

    if (!tokenResponse.ok) {
      const errBody = await tokenResponse.text().catch(() => '');
      console.error('❌ Discord token exchange falló:', tokenResponse.status, errBody);
      throw new Error(`Error obteniendo token de Discord [${tokenResponse.status}]: ${errBody || 'sin detalle'}`);
    }

    const tokenData = await tokenResponse.json();

    const userResponse = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `${tokenData.token_type} ${tokenData.access_token}` }
    });

    if (!userResponse.ok) {
      const errBody = await userResponse.text().catch(() => '');
      console.error('❌ Discord @me falló:', userResponse.status, errBody);
      throw new Error(`Error obteniendo usuario de Discord [${userResponse.status}]: ${errBody || 'sin detalle'}`);
    }

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

    // Guardamos en sesión y en BD, pero NO marcamos fully_verified todavía:
    // primero el usuario confirma que esa es su cuenta (paso de confirmación).
    req.session.discordUser.roblox_id = robloxUser.id;
    req.session.discordUser.roblox_username = robloxUser.name;
    req.session.discordUser.roblox_avatar = avatarUrl;

    res.redirect('/verificacion.html?step=2&confirmar=1');
  } catch (err) {
    console.error('Error Roblox callback:', err.message);
    res.status(500).send('Error verificando Roblox: ' + err.message);
  }
});

// --- Desvincular Roblox ("No, cambiar cuenta") ---
app.post('/api/roblox/reset', requireAuth, async (req, res) => {
  try {
    const discordId = String(req.session.discordUser.id);
    await pool.query(
      `UPDATE verified_users
       SET roblox_id = NULL, roblox_username = NULL, roblox_avatar = NULL,
           roblox_verified_at = NULL, fully_verified = 0, updated_at = NOW()
       WHERE discord_id = ?`,
      [discordId]
    );
    req.session.discordUser.roblox_id = null;
    req.session.discordUser.roblox_username = null;
    req.session.discordUser.roblox_avatar = null;
    console.log(`🔄 Roblox desvinculado por ${discordId}`);
    res.json({ success: true });
  } catch (err) {
    console.error('Error roblox/reset:', err.message);
    res.status(500).json({ error: 'Error interno' });
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

// ============================================================
// ✈️ LAN ATC OPERATIONS — Flight Strips y transferencias
// ============================================================
const ATC_ROLE = '1555512718046404609';
const ATC_INSTRUCTOR_ROLE = '1555512949391495218';

async function esControlador(discordId) {
  const ids = await obtenerRangosIds(discordId);
  return ids.includes(ATC_ROLE) || ids.includes(ATC_INSTRUCTOR_ROLE) || STAFF_ROLES.some(r => ids.includes(r));
}
async function nombreControlador(discordId) {
  const [rows] = await pool.query(
    'SELECT discord_global_name, discord_username FROM verified_users WHERE discord_id = ?', [discordId]
  );
  if (!rows.length) return 'Controlador';
  return rows[0].discord_global_name || rows[0].discord_username || 'Controlador';
}
function stripPublico(r) {
  return {
    id: r.id,
    callsign: (r.airline || '') + (r.flight_number || '') || ('#' + r.id),
    flight_number: r.flight_number || '',
    airline: r.airline || '',
    aircraft: r.aircraft,
    registration: r.registration || '',
    flight_rules: r.flight_rules,
    departure: r.departure,
    destination: r.destination,
    cruise_altitude: r.cruise_altitude || '',
    alternate: r.alternate || '',
    squawk: r.squawk || null,          // ATC ve el squawk
    squawk_validated: !!r.squawk_validated,
    atc_stage: r.atc_stage,
    flight_kind: r.flight_kind || 'DEP',
    runway: r.runway || null,
    sid: r.sid || null,
    status: r.status,
    atc_controller_id: r.atc_controller_id || null,
    username: r.discord_global_name || r.discord_username || r.discord_id,
    discord_id: r.discord_id,
    created_at: r.created_at
  };
}

// Aeropuertos disponibles
app.get('/api/atc/airports', requireAuth, async (req, res) => {
  try {
    if (!(await esControlador(req.session.discordUser.id))) {
      return res.status(403).json({ error: 'Sin permisos ATC' });
    }
    const [rows] = await pool.query('SELECT code, name FROM atc_airports WHERE active = 1 ORDER BY code');
    res.json({ airports: rows });
  } catch (err) {
    console.error('Error atc/airports:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// Posiciones (ocupadas/libres) de un aeropuerto
app.get('/api/atc/positions', requireAuth, async (req, res) => {
  try {
    if (!(await esControlador(req.session.discordUser.id))) {
      return res.status(403).json({ error: 'Sin permisos ATC' });
    }
    const airport = String(req.query.airport || '').slice(0, 8).toUpperCase();
    const [rows] = await pool.query(
      `SELECT id, airport_code, position, controller_id, controller_name, session_start,
              TIMESTAMPDIFF(SECOND, session_start, NOW()) AS seconds_on
       FROM atc_positions WHERE airport_code = ? ORDER BY FIELD(position,'DEL','GND','TWR')`,
      [airport]
    );
    res.json({ positions: rows });
  } catch (err) {
    console.error('Error atc/positions:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// Tomar / liberar posición
app.post('/api/atc/position/:id/take', requireAuth, async (req, res) => {
  try {
    const discordId = String(req.session.discordUser.id);
    if (!(await esControlador(discordId))) return res.status(403).json({ error: 'Sin permisos ATC' });
    const [rows] = await pool.query('SELECT * FROM atc_positions WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Posición no encontrada' });
    const pos = rows[0];
    if (pos.controller_id && pos.controller_id !== discordId &&
        !(await esStaff(discordId))) {
      return res.status(409).json({ error: 'Esta posición ya está ocupada por ' + (pos.controller_name || 'otro controlador') });
    }
    const nombre = await nombreControlador(discordId);
    await pool.query(
      `UPDATE atc_positions SET controller_id = ?, controller_name = ?, session_start = NOW()
       WHERE id = ?`,
      [discordId, nombre, pos.id]
    );
    await registrarOperacion(pos.airport_code, null, pos.position, `Posición ${pos.position} ocupada por ${nombre}`, discordId, nombre);
    res.json({ success: true, controller_id: discordId, controller_name: nombre });
  } catch (err) {
    console.error('Error atc/position/take:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});
app.post('/api/atc/position/:id/release', requireAuth, async (req, res) => {
  try {
    const discordId = String(req.session.discordUser.id);
    if (!(await esControlador(discordId))) return res.status(403).json({ error: 'Sin permisos ATC' });
    const [rows] = await pool.query('SELECT * FROM atc_positions WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Posición no encontrada' });
    const pos = rows[0];
    if (pos.controller_id && pos.controller_id !== discordId && !(await esStaff(discordId))) {
      return res.status(403).json({ error: 'No puedes liberar la posición de otro controlador' });
    }
    await pool.query(
      'UPDATE atc_positions SET controller_id = NULL, controller_name = NULL, session_start = NULL WHERE id = ?',
      [pos.id]
    );
    await registrarOperacion(pos.airport_code, null, pos.position, `Posición ${pos.position} liberada`, discordId, pos.controller_name);
    res.json({ success: true });
  } catch (err) {
    console.error('Error atc/position/release:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// Flight Strips por aeropuerto y posición
app.get('/api/atc/strips', requireAuth, async (req, res) => {
  try {
    if (!(await esControlador(req.session.discordUser.id))) {
      return res.status(403).json({ error: 'Sin permisos ATC' });
    }
    const airport = String(req.query.airport || '').slice(0, 8).toUpperCase();
    const [rows] = await pool.query(
      `SELECT s.*, u.discord_username, u.discord_global_name
       FROM flight_plans s
       LEFT JOIN verified_users u ON u.discord_id = s.discord_id
       WHERE s.status NOT IN ('draft','rejected','cancelled')
       ORDER BY FIELD(COALESCE(s.atc_stage,'DEL'),'DEL','GND','TWR','FINISHED'), s.id DESC`
    );
    // Los planes viejos sin atc_stage se muestran en Delivery
    const strips = rows.map(r => {
      if (!r.atc_stage && r.status === 'pending') r.atc_stage = 'DEL';
      if (!r.atc_stage && ['approved','active','finished'].includes(r.status)) r.atc_stage = 'FINISHED';
      return stripPublico(r);
    });
    res.json({ strips });
  } catch (err) {
    console.error('Error atc/strips:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// Ficha completa de un vuelo (solo ATC)
app.get('/api/atc/strips/:id', requireAuth, async (req, res) => {
  try {
    if (!(await esControlador(req.session.discordUser.id))) {
      return res.status(403).json({ error: 'Sin permisos ATC' });
    }
    const [rows] = await pool.query(
      `SELECT s.*, u.discord_username, u.discord_global_name
       FROM flight_plans s LEFT JOIN verified_users u ON u.discord_id = s.discord_id
       WHERE s.id = ?`, [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Vuelo no encontrado' });
    res.json({ strip: stripPublico(rows[0]) });
  } catch (err) {
    console.error('Error atc/strip/:id:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// Delivery: autorizar (requiere squawk validado por el piloto) → Ground
app.post('/api/atc/strips/:id/clear', requireAuth, async (req, res) => {
  try {
    const discordId = String(req.session.discordUser.id);
    if (!(await esControlador(discordId))) return res.status(403).json({ error: 'Sin permisos ATC' });
    const [rows] = await pool.query('SELECT * FROM flight_plans WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Vuelo no encontrado' });
    const fp = rows[0];
    if (fp.atc_stage !== 'DEL') return res.status(409).json({ error: 'El vuelo no está en Delivery' });
    if (!fp.squawk_validated) {
      return res.status(409).json({ error: 'El piloto aún no ha validado el Squawk en ATC Clearance.' });
    }
    const runway = String(req.body.runway || '').trim().slice(0, 8).toUpperCase();
    const sid = String(req.body.sid || '').trim().slice(0, 40).toUpperCase();
    if (!runway) return res.status(400).json({ error: 'Indica la pista asignada.' });
    const nombre = await nombreControlador(discordId);
    await pool.query(
      `UPDATE flight_plans SET atc_stage = 'GND', status = 'approved', runway = ?, sid = ?,
       atc_controller_id = ?, cleared_at = NOW(), updated_at = NOW() WHERE id = ?`,
      [runway, sid, discordId, fp.id]
    );
    const callsign = (fp.airline || '') + (fp.flight_number || '');
    await registrarOperacion(fp.departure, callsign, 'DEL', 'Autorización IFR/VFR concedida. Transferido a Ground.', discordId, nombre);
    await notificar(fp.discord_id, 'Delivery ha concedido tu autorización',
      `${callsign}: autorización concedida, pista ${runway}. Transferido a Ground.`, 'check');
    res.json({ success: true, atc_stage: 'GND' });
  } catch (err) {
    console.error('Error atc/clear:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// Ground: instrucción de rodaje → Tower
app.post('/api/atc/strips/:id/taxi', requireAuth, async (req, res) => {
  try {
    const discordId = String(req.session.discordUser.id);
    if (!(await esControlador(discordId))) return res.status(403).json({ error: 'Sin permisos ATC' });
    const [rows] = await pool.query('SELECT * FROM flight_plans WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Vuelo no encontrado' });
    const fp = rows[0];
    if (fp.atc_stage !== 'GND') return res.status(409).json({ error: 'El vuelo no está en Ground' });
    const nombre = await nombreControlador(discordId);
    await pool.query(
      `UPDATE flight_plans SET atc_stage = 'TWR', atc_controller_id = ?, taxi_at = NOW(), updated_at = NOW() WHERE id = ?`,
      [discordId, fp.id]
    );
    const callsign = (fp.airline || '') + (fp.flight_number || '');
    await registrarOperacion(fp.departure, callsign, 'GND', 'Rodaje completado. Transferido a Tower.', discordId, nombre);
    await notificar(fp.discord_id, 'Tu vuelo ha sido transferido a Ground',
      `${callsign}: rodaje autorizado y completado. Ahora en Tower.`, 'plane');
    res.json({ success: true, atc_stage: 'TWR' });
  } catch (err) {
    console.error('Error atc/taxi:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// Tower: despegue (salida) o aterrizaje (llegada)
app.post('/api/atc/strips/:id/tower', requireAuth, async (req, res) => {
  try {
    const discordId = String(req.session.discordUser.id);
    if (!(await esControlador(discordId))) return res.status(403).json({ error: 'Sin permisos ATC' });
    const [rows] = await pool.query('SELECT * FROM flight_plans WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Vuelo no encontrado' });
    const fp = rows[0];
    if (fp.atc_stage !== 'TWR') return res.status(409).json({ error: 'El vuelo no está en Tower' });
    const accion = req.body && req.body.action;    // 'takeoff' | 'landing'
    const nombre = await nombreControlador(discordId);
    const callsign = (fp.airline || '') + (fp.flight_number || '');
    if (accion === 'landing') {
      // Llegada: Tower → Ground (rodaje a plataforma)
      await pool.query(
        `UPDATE flight_plans SET atc_stage = 'GND', atc_controller_id = ?, updated_at = NOW() WHERE id = ?`,
        [discordId, fp.id]
      );
      await registrarOperacion(fp.destination, callsign, 'TWR', 'Aterrizaje completado. Transferido a Ground.', discordId, nombre);
      await notificar(fp.discord_id, 'Tu vuelo ha aterrizado', `${callsign}: transferido a Ground para rodaje a plataforma.`, 'plane');
      return res.json({ success: true, atc_stage: 'GND' });
    }
    // Salida: despegue → EN EL AIRE
    await pool.query(
      `UPDATE flight_plans SET atc_stage = 'AIR', status = 'active',
       atc_controller_id = ?, updated_at = NOW() WHERE id = ?`,
      [discordId, fp.id]
    );
    await registrarOperacion(fp.departure, callsign, 'TWR', 'Despegue completado. Vuelo en el aire.', discordId, nombre);
    await notificar(fp.discord_id, 'Tu vuelo está en el aire', `${callsign}: despegue autorizado. Vuelo en el aire.`, 'plane');
    res.json({ success: true, atc_stage: 'AIR' });
  } catch (err) {
    console.error('Error atc/tower:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// En el aire → Finalizado (el ATC da el vuelo por terminado)
app.post('/api/atc/strips/:id/finish', requireAuth, async (req, res) => {
  try {
    const discordId = String(req.session.discordUser.id);
    if (!(await esControlador(discordId))) return res.status(403).json({ error: 'Sin permisos ATC' });
    const [rows] = await pool.query('SELECT * FROM flight_plans WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Vuelo no encontrado' });
    const fp = rows[0];
    if (fp.atc_stage !== 'AIR') return res.status(409).json({ error: 'El vuelo no está en el aire' });
    const nombre = await nombreControlador(discordId);
    const callsign = (fp.airline || '') + (fp.flight_number || '');
    await pool.query(
      `UPDATE flight_plans SET atc_stage = 'FINISHED', status = 'finished', finished_at = NOW(),
       atc_controller_id = ?, updated_at = NOW() WHERE id = ?`,
      [discordId, fp.id]
    );
    await registrarOperacion(fp.destination, callsign, 'AIR', 'Vuelo finalizado.', discordId, nombre);
    await notificar(fp.discord_id, 'Tu vuelo ha finalizado', `${callsign}: operación finalizada.`, 'check');
    res.json({ success: true, atc_stage: 'FINISHED' });
  } catch (err) {
    console.error('Error atc/finish:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// Ground (llegada): rodaje a plataforma → finalizado
app.post('/api/atc/strips/:id/park', requireAuth, async (req, res) => {
  try {
    const discordId = String(req.session.discordUser.id);
    if (!(await esControlador(discordId))) return res.status(403).json({ error: 'Sin permisos ATC' });
    const [rows] = await pool.query('SELECT * FROM flight_plans WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Vuelo no encontrado' });
    const fp = rows[0];
    if (fp.atc_stage !== 'GND' || fp.flight_kind !== 'ARR') {
      return res.status(409).json({ error: 'Solo se puede estacionar una llegada en Ground' });
    }
    const nombre = await nombreControlador(discordId);
    await pool.query(
      `UPDATE flight_plans SET atc_stage = 'FINISHED', status = 'finished', finished_at = NOW(),
       atc_controller_id = ?, updated_at = NOW() WHERE id = ?`,
      [discordId, fp.id]
    );
    const callsign = (fp.airline || '') + (fp.flight_number || '');
    await registrarOperacion(fp.destination, callsign, 'GND', 'Rodaje a plataforma completado. Vuelo finalizado.', discordId, nombre);
    await notificar(fp.discord_id, 'Tu vuelo ha finalizado', `${callsign}: en plataforma. Operación finalizada.`, 'check');
    res.json({ success: true, atc_stage: 'FINISHED' });
  } catch (err) {
    console.error('Error atc/park:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// Historial de operaciones
app.get('/api/atc/log', requireAuth, async (req, res) => {
  try {
    if (!(await esControlador(req.session.discordUser.id))) {
      return res.status(403).json({ error: 'Sin permisos ATC' });
    }
    const airport = String(req.query.airport || '').slice(0, 8).toUpperCase();
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const POR_PAGINA = 5;

    // 🧹 Borrar operaciones con más de 2 días (se hace en cada consulta)
    await pool.query('DELETE FROM atc_operations WHERE created_at < DATE_SUB(NOW(), INTERVAL 2 DAY)');

    const where = airport ? 'WHERE airport_code = ?' : '';
    const params = airport ? [airport] : [];

    // Combinar: operaciones ATC reales + planes de vuelo (para que ningún vuelo falte)
    const [ops] = await pool.query(
      `SELECT * FROM atc_operations ${where}`, params
    );
    const [planes] = await pool.query(
      `SELECT id, departure, destination, airline, flight_number, status, atc_stage,
              created_at, updated_at
       FROM flight_plans
       WHERE created_at >= DATE_SUB(NOW(), INTERVAL 2 DAY)`
    );
    const historial = [
      ...ops.map(o => ({
        id: 'op-' + o.id,
        callsign: o.callsign || '',
        action: o.action,
        controller_name: o.controller_name || '',
        airport_code: o.airport_code,
        created_at: o.created_at,
        tipo: 'op'
      })),
      ...planes.map(p => ({
        id: 'fp-' + p.id,
        callsign: (p.airline || '') + (p.flight_number || '') || ('#' + p.id),
        action: p.atc_stage
          ? 'Plan de vuelo en ' + p.atc_stage + ' · ' + p.status
          : 'Plan de vuelo recibido · ' + p.status,
        controller_name: '',
        airport_code: p.departure,
        created_at: p.created_at,
        tipo: 'plan'
      }))
    ].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    const total = historial.length;
    const pageRows = historial.slice((page - 1) * POR_PAGINA, page * POR_PAGINA);
    res.json({ operations: pageRows, total, page, pages: Math.max(1, Math.ceil(total / POR_PAGINA)) });
  } catch (err) {
    console.error('Error atc/log:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// Validar Squawk (piloto digita el código que le dio Delivery)
app.post('/api/flight-plans/:id/validate-squawk', requireAuth, async (req, res) => {
  try {
    const discordId = await requiereAprobacion(req, res);
    if (!discordId) return;
    const [rows] = await pool.query('SELECT * FROM flight_plans WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Plan no encontrado' });
    const fp = rows[0];
    if (fp.discord_id !== discordId) return res.status(403).json({ error: 'No es tu plan' });
    if (!fp.squawk) return res.status(409).json({ error: 'Este plan aún no tiene squawk asignado.' });
    const code = String(req.body && req.body.squawk ? String(req.body.squawk).trim() : '');
    if (!/^\d{4}$/.test(code)) return res.status(400).json({ error: 'Ingresa 4 dígitos.' });
    if (code !== fp.squawk) {
      return res.status(400).json({ error: 'El código no coincide. Verifica con Delivery.' });
    }
    await pool.query('UPDATE flight_plans SET squawk_validated = 1, updated_at = NOW() WHERE id = ?', [fp.id]);
    await notificar(discordId, 'Tu Squawk ha sido validado',
      `Código ${fp.squawk} confirmado. Tu vuelo está listo para transferencia a Ground.`, 'check');
    res.json({ success: true, validated: true });
  } catch (err) {
    console.error('Error validate-squawk:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// Notificaciones internas del usuario
app.get('/api/notifications', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT id, title, message, icon, read_at, created_at FROM lan_notifications WHERE discord_id = ? ORDER BY id DESC LIMIT 30',
      [String(req.session.discordUser.id)]
    );
    res.json({ notifications: rows });
  } catch (err) {
    console.error('Error notifications:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});
// Marcar una como leída
app.post('/api/notifications/:id/read', requireAuth, async (req, res) => {
  try {
    await pool.query(
      'UPDATE lan_notifications SET read_at = NOW() WHERE id = ? AND discord_id = ?',
      [req.params.id, String(req.session.discordUser.id)]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Error notifications/read:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// Borrar UNA notificación
app.post('/api/notifications/:id/delete', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM lan_notifications WHERE id = ? AND discord_id = ?',
      [req.params.id, String(req.session.discordUser.id)]);
    res.json({ success: true });
  } catch (err) {
    console.error('Error notifications/delete:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// Borrar TODAS las notificaciones del usuario
app.post('/api/notifications/delete-all', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM lan_notifications WHERE discord_id = ?', [String(req.session.discordUser.id)]);
    res.json({ success: true });
  } catch (err) {
    console.error('Error notifications/delete-all:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// Ruta protegida del Dashboard ATC
app.get('/dashboard/atc-operations', requireVerificado, async (req, res) => {
  try {
    if (!(await esControlador(String(req.session.discordUser.id)))) {
      return res.redirect('/dashboard');
    }
    res.sendFile(path.join(__dirname, 'public', 'atc-operations.html'));
  } catch (err) {
    console.error('Error atc-operations:', err.message);
    res.redirect('/dashboard');
  }
});

// Ruta protegida de ATC Clearance (piloto valida el squawk)
app.get('/dashboard/atc-clearance', requireVerificado, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'atc-clearance.html'));
});

// ============================================================
// 📋 CARTAS DE VUELO (Flight Charts) — solo vuelos autorizados
// ============================================================
app.get('/api/flight-charts', requireAuth, async (req, res) => {
  try {
    const discordId = String(req.session.discordUser.id);
    const id = req.query.id;
    const controlador = await esControlador(discordId);
    let sql = `
      SELECT s.*, u.discord_username, u.discord_global_name
      FROM flight_plans s
      LEFT JOIN verified_users u ON u.discord_id = s.discord_id
      WHERE (s.squawk_validated = 1 OR s.status IN ('approved','active','finished'))`;
    const params = [];
    if (!controlador) { sql += ' AND s.discord_id = ?'; params.push(discordId); }
    if (id) { sql += ' AND s.id = ?'; params.push(id); }
    sql += ' ORDER BY FIELD(s.atc_stage,\'GND\',\'TWR\',\'FINISHED\',\'DEL\'), s.id DESC';
    const [rows] = await pool.query(sql, params);
    const charts = rows.map(r => {
      const c = planPublico(r, controlador || !!r.squawk_validated);
      c.callsign = (r.airline || '') + (r.flight_number || '') || ('#' + r.id);
      return c;
    });
    res.json({ charts, is_atc: controlador });
  } catch (err) {
    console.error('Error flight-charts:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

app.get('/dashboard/cartas-de-vuelo', requireVerificado, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'cartas-de-vuelo.html'));
});

// --- Logout: destruye la sesión y borra la cookie (await para que no reviva) ---
app.get('/auth/logout', (req, res) => {
  req.session.destroy(err => {
    res.clearCookie('connect.sid', { path: '/' });
    if (err) console.error('Error al destruir sesión:', err.message);
    res.redirect('/iniciar-seccion.html');   // vuelve al login (sin sesión ya no redirige al dashboard)
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Servidor en http://0.0.0.0:${PORT}`);
});
