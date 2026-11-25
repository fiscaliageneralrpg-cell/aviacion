-- ============================================================
--  LATIN AVIATION NETWORK — Tablas para la base de datos NUEVA
--  Cómo usarlo en HeidiSQL:
--   1) Conéctate a tu base de datos nueva
--   2) Pega TODO este contenido en una pestaña de consulta (Query)
--   3) Presiona el botón ▶ (Ejecutar)
--   4) Verás las 4 tablas en el panel izquierdo (F5 para refrescar)
-- ============================================================

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

-- ============================================================
--  LISTO. Son 4 tablas: verified_users, site_stats,
--  user_roles, academy_submissions.
--  (No existe tabla de sesiones: van en memoria.)
-- ============================================================
