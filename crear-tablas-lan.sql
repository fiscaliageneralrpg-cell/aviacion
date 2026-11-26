-- ============================================================
--  LATIN AVIATION NETWORK — Base de datos COMPLETA
--  Cómo usarlo en HeidiSQL:
--   1) Conéctate al servidor (176.100.37.77:3306)
--   2) Pega TODO en una pestaña Query y presiona ▶ Ejecutar
--   3) F5 en el panel izquierdo para ver la BD y sus tablas
-- ============================================================

CREATE DATABASE IF NOT EXISTS `s61797_aviacion`
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_unicode_ci;
USE `s61797_aviacion`;

-- ------------------------------------------------------------
-- 1) USUARIOS VERIFICADOS (Discord + Roblox + ruta Piloto/ATC)
--    La web la usa en login, verificación, dashboard y ruta.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS verified_users (
  id                 INT AUTO_INCREMENT PRIMARY KEY,
  discord_id         VARCHAR(20)  NOT NULL,
  discord_username   VARCHAR(100) DEFAULT NULL,
  discord_global_name VARCHAR(100) DEFAULT NULL,
  discord_avatar     VARCHAR(500) DEFAULT NULL,
  discord_verified_at DATETIME    DEFAULT NULL,
  roblox_id          VARCHAR(30)  DEFAULT NULL,
  roblox_username    VARCHAR(100) DEFAULT NULL,
  roblox_avatar      VARCHAR(500) DEFAULT NULL,
  roblox_verified_at DATETIME     DEFAULT NULL,
  fully_verified     TINYINT(1)   NOT NULL DEFAULT 0,
  track              VARCHAR(10)  DEFAULT NULL,   -- 'piloto' | 'atc' | NULL
  created_at         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_verified_users_discord (discord_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ------------------------------------------------------------
-- 2) ESTADÍSTICAS DEL SITIO (contador de miembros del Discord)
--    El bot escribe member_count cada 5 segundos; la web lo lee.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS site_stats (
  id           INT NOT NULL PRIMARY KEY,
  member_count INT  NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Fila base: el bot hace "UPDATE site_stats SET member_count = ? WHERE id = 1"
-- Sin esta fila el contador nunca se guarda.
INSERT INTO site_stats (id, member_count) VALUES (1, 0)
  ON DUPLICATE KEY UPDATE id = id;

-- ------------------------------------------------------------
-- 3) RANGOS DE DISCORD POR USUARIO
--    El bot la escribe (al entrar, cambiar de rol, cada 60 s);
--    la web la lee para mostrar el rango en el dashboard.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_roles (
  discord_id       VARCHAR(20) NOT NULL,
  role_ids         TEXT        NOT NULL,
  highest_role_id  VARCHAR(20) DEFAULT NULL,
  updated_at       TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (discord_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ------------------------------------------------------------
-- 4) FORMULARIOS DE LAN ACADEMY
--    El envío/calificación es desde la web; el bot solo cambia
--    roles (role_action → role_action_done) al aprobar.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS academy_submissions (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  discord_id        VARCHAR(20) NOT NULL,
  answers           TEXT        NOT NULL,
  status            VARCHAR(20) NOT NULL DEFAULT 'submitted', -- none|submitted|graded|approved|denied
  score             INT         DEFAULT NULL,
  total             INT         NOT NULL DEFAULT 20,
  staff_discord_id  VARCHAR(20) DEFAULT NULL,
  graded_at         DATETIME    DEFAULT NULL,
  role_action       TINYINT     NOT NULL DEFAULT 0,  -- 1 = bot debe cambiar rol
  role_action_done  TINYINT     NOT NULL DEFAULT 0,
  denied_ack        TINYINT     NOT NULL DEFAULT 0,  -- usuario aceptó el aviso de denegado
  dm_pending        TINYINT     NOT NULL DEFAULT 0,  -- DM de denegado pendiente
  denied_at         DATETIME    DEFAULT NULL,        -- controla cooldown de 1 h
  created_at        DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_academy_discord (discord_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ------------------------------------------------------------
-- 5) PLANES DE VUELO (Flight Planning)
--    El piloto crea/envía/cancela; el ATC (rol
--    1555512718046404609) revisa, asigna estado y squawk.
--    Estados: draft|pending|approved|active|finished|rejected|cancelled
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS flight_plans (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  discord_id       VARCHAR(20) NOT NULL,
  status           VARCHAR(20) NOT NULL DEFAULT 'draft',
  flight_rules     VARCHAR(10) NOT NULL DEFAULT 'IFR',
  departure        VARCHAR(12) NOT NULL,
  destination      VARCHAR(12) NOT NULL,
  airline          VARCHAR(60) DEFAULT NULL,
  registration     VARCHAR(20) DEFAULT NULL,
  flight_number    VARCHAR(20) DEFAULT NULL,
  aircraft         VARCHAR(12) NOT NULL,
  cruise_altitude  VARCHAR(20) DEFAULT NULL,
  `alternate`      VARCHAR(12) DEFAULT NULL,
  squawk           VARCHAR(4)  DEFAULT NULL,
  rejection_reason TEXT        DEFAULT NULL,
  reviewed_by      VARCHAR(20) DEFAULT NULL,
  reviewed_at      DATETIME    DEFAULT NULL,
  created_at       DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_fp_discord (discord_id),
  KEY idx_fp_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ------------------------------------------------------------
--  Columnas ATC Operations (el servidor las agrega solo, pero
--  aquí están para que la BD quede completa desde el inicio)
-- ------------------------------------------------------------
ALTER TABLE flight_plans
  ADD COLUMN atc_stage VARCHAR(12) DEFAULT NULL,
  ADD COLUMN flight_kind VARCHAR(4) DEFAULT NULL,
  ADD COLUMN runway VARCHAR(8) DEFAULT NULL,
  ADD COLUMN sid VARCHAR(40) DEFAULT NULL,
  ADD COLUMN squawk_validated TINYINT NOT NULL DEFAULT 0,
  ADD COLUMN atc_controller_id VARCHAR(20) DEFAULT NULL,
  ADD COLUMN cleared_at DATETIME DEFAULT NULL,
  ADD COLUMN taxi_at DATETIME DEFAULT NULL,
  ADD COLUMN finished_at DATETIME DEFAULT NULL;

-- 6) AEROPUERTOS ATC
CREATE TABLE IF NOT EXISTS atc_airports (
  code VARCHAR(8) NOT NULL PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  active TINYINT NOT NULL DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO atc_airports (code, name) VALUES
  ('SKBO','El Dorado International'), ('SKRG','José María Córdova'), ('SKIB','Perales'),
  ('EGFF','Cardiff Airport'), ('EGKK','London Gatwick'), ('EGLC','London City'),
  ('LCLK','Larnaca International'), ('LCPH','Paphos International'), ('LCRA','RAF Akrotiri'),
  ('LPMA','Madeira Airport'), ('MDAB','Arroyo Barril International'), ('MDCR','Cabo Rojo'),
  ('MDPC','Punta Cana International'), ('MDST','Cibao International'),
  ('MTCA','Cap-Haitien International'), ('PAFA','Fairbanks International');

-- 7) POSICIONES ATC (DEL/GND/TWR) — un controlador por posición
CREATE TABLE IF NOT EXISTS atc_positions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  airport_code VARCHAR(8) NOT NULL,
  position VARCHAR(4) NOT NULL,
  controller_id VARCHAR(20) DEFAULT NULL,
  controller_name VARCHAR(120) DEFAULT NULL,
  session_start DATETIME DEFAULT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_atc_pos (airport_code, position)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 8) HISTORIAL DE OPERACIONES ATC
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 9) NOTIFICACIONES INTERNAS
CREATE TABLE IF NOT EXISTS lan_notifications (
  id INT AUTO_INCREMENT PRIMARY KEY,
  discord_id VARCHAR(20) NOT NULL,
  title VARCHAR(120) NOT NULL,
  message VARCHAR(500) NOT NULL,
  icon VARCHAR(20) DEFAULT 'plane',
  read_at DATETIME DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_notif_user (discord_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
--  LISTO. Tablas: verified_users, site_stats, user_roles,
--  academy_submissions, flight_plans, atc_airports,
--  atc_positions, atc_operations, lan_notifications.
-- ============================================================
