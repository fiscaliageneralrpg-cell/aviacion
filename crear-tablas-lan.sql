-- ============================================================
--  LATIN AVIATION NETWORK — Base de datos COMPLETA
--  Para OryHost: botón "Import .sql" en Databases
-- ============================================================

CREATE DATABASE IF NOT EXISTS `s61797_AVIACION`
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_unicode_ci;
USE `s61797_AVIACION`;

-- 1) USUARIOS VERIFICADOS
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
  track              VARCHAR(10)  DEFAULT NULL,
  track_role_done    TINYINT NOT NULL DEFAULT 0,
  created_at         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_verified_users_discord (discord_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 2) ESTADÍSTICAS
CREATE TABLE IF NOT EXISTS site_stats (
  id           INT NOT NULL PRIMARY KEY,
  member_count INT NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
INSERT INTO site_stats (id, member_count) VALUES (1, 0)
  ON DUPLICATE KEY UPDATE id = id;

-- 3) RANGOS DE DISCORD
CREATE TABLE IF NOT EXISTS user_roles (
  discord_id       VARCHAR(20) NOT NULL,
  role_ids         TEXT        NOT NULL,
  highest_role_id  VARCHAR(20) DEFAULT NULL,
  updated_at       TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (discord_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 4) FORMULARIOS LAN ACADEMY
CREATE TABLE IF NOT EXISTS academy_submissions (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  discord_id        VARCHAR(20) NOT NULL,
  answers           TEXT        NOT NULL,
  status            VARCHAR(20) NOT NULL DEFAULT 'submitted',
  score             INT         DEFAULT NULL,
  total             INT         NOT NULL DEFAULT 20,
  staff_discord_id  VARCHAR(20) DEFAULT NULL,
  graded_at         DATETIME    DEFAULT NULL,
  role_action       TINYINT     NOT NULL DEFAULT 0,
  role_action_done  TINYINT     NOT NULL DEFAULT 0,
  denied_ack        TINYINT     NOT NULL DEFAULT 0,
  dm_pending        TINYINT     NOT NULL DEFAULT 0,
  denied_at         DATETIME    DEFAULT NULL,
  created_at        DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_academy_discord (discord_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 5) PLANES DE VUELO (con columnas ATC incluidas)
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
  atc_stage        VARCHAR(12) DEFAULT NULL,
  flight_kind      VARCHAR(4)  DEFAULT NULL,
  runway           VARCHAR(8)  DEFAULT NULL,
  sid              VARCHAR(40) DEFAULT NULL,
  squawk_validated TINYINT NOT NULL DEFAULT 0,
  atc_controller_id VARCHAR(20) DEFAULT NULL,
  cleared_at       DATETIME DEFAULT NULL,
  taxi_at          DATETIME DEFAULT NULL,
  finished_at      DATETIME DEFAULT NULL,
  created_at       DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_fp_discord (discord_id),
  KEY idx_fp_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

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

-- 7) POSICIONES ATC
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

-- LISTO: 9 tablas