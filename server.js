const express = require('express');
const path = require('path');
const cors = require('cors');
const dotenv = require('dotenv');
const mysql = require('mysql2/promise');

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