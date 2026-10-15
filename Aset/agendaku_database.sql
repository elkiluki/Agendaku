-- =====================================================
-- DATABASE AGENDAKU
-- Pemrograman Mobile (SIF125113) - PjBL Tahap 1
-- Dibuat sesuai Bagian 6.2 Struktur Data pada dokumen
-- =====================================================

CREATE DATABASE IF NOT EXISTS agendaku
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE agendaku;

-- -----------------------------------------------------
-- 1. users  (US-05: akun & login)
-- -----------------------------------------------------
CREATE TABLE users (
  user_id     INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name        VARCHAR(100) NOT NULL,
  email       VARCHAR(150) NOT NULL,
  password    VARCHAR(255) NOT NULL,              -- simpan hash bcrypt, bukan teks asli
  push_token  VARCHAR(255) NULL,                  -- token Expo Push untuk notifikasi (US-04, US-12)
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id),
  UNIQUE KEY uq_users_email (email)
) ENGINE=InnoDB;

-- -----------------------------------------------------
-- 2. workspaces  (US-06: ruang kerja kolaboratif)
-- -----------------------------------------------------
CREATE TABLE workspaces (
  workspace_id  INT UNSIGNED NOT NULL AUTO_INCREMENT,
  owner_id      INT UNSIGNED NOT NULL,
  name          VARCHAR(100) NOT NULL,
  description   TEXT NULL,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id),
  KEY idx_workspaces_owner (owner_id),
  CONSTRAINT fk_workspaces_owner
    FOREIGN KEY (owner_id) REFERENCES users (user_id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;

-- -----------------------------------------------------
-- 3. workspace_members  (anggota ruang kerja)
-- -----------------------------------------------------
CREATE TABLE workspace_members (
  member_id     INT UNSIGNED NOT NULL AUTO_INCREMENT,
  workspace_id  INT UNSIGNED NOT NULL,
  user_id       INT UNSIGNED NOT NULL,
  role          ENUM('owner','member') NOT NULL DEFAULT 'member',
  joined_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (member_id),
  UNIQUE KEY uq_workspace_user (workspace_id, user_id),   -- 1 user tidak boleh dobel di 1 workspace
  KEY idx_wm_user (user_id),
  CONSTRAINT fk_wm_workspace
    FOREIGN KEY (workspace_id) REFERENCES workspaces (workspace_id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_wm_user
    FOREIGN KEY (user_id) REFERENCES users (user_id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;

-- -----------------------------------------------------
-- 4. tasks  (US-01, 02, 03, 07, 10)
--    workspace_id NULL  = tugas pribadi
--    workspace_id ISI   = tugas kelompok
-- -----------------------------------------------------
CREATE TABLE tasks (
  task_id       INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id       INT UNSIGNED NOT NULL,            -- pembuat tugas
  workspace_id  INT UNSIGNED NULL,
  title         VARCHAR(150) NOT NULL,
  description   TEXT NULL,
  deadline      DATETIME NOT NULL,
  status        ENUM('belum_dikerjakan','sedang_dikerjakan','selesai')
                NOT NULL DEFAULT 'belum_dikerjakan',
  label_color   VARCHAR(7) NULL,                  -- contoh: '#FF5733' (US-10)
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (task_id),
  KEY idx_tasks_user_deadline (user_id, deadline),            -- mempercepat pengurutan deadline
  KEY idx_tasks_workspace_deadline (workspace_id, deadline),
  KEY idx_tasks_status (status),
  CONSTRAINT fk_tasks_user
    FOREIGN KEY (user_id) REFERENCES users (user_id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_tasks_workspace
    FOREIGN KEY (workspace_id) REFERENCES workspaces (workspace_id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;

-- -----------------------------------------------------
-- 5. task_assignments  (US-06, US-09: pembagian & kontribusi)
--    completed_at terisi = anggota tsb sudah menyelesaikan bagiannya
-- -----------------------------------------------------
CREATE TABLE task_assignments (
  assignment_id  INT UNSIGNED NOT NULL AUTO_INCREMENT,
  task_id        INT UNSIGNED NOT NULL,
  user_id        INT UNSIGNED NOT NULL,
  assigned_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at   DATETIME NULL,
  PRIMARY KEY (assignment_id),
  UNIQUE KEY uq_task_user (task_id, user_id),
  KEY idx_ta_user (user_id),
  CONSTRAINT fk_ta_task
    FOREIGN KEY (task_id) REFERENCES tasks (task_id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_ta_user
    FOREIGN KEY (user_id) REFERENCES users (user_id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;

-- -----------------------------------------------------
-- 6. reminders  (US-04: notifikasi pengingat)
-- -----------------------------------------------------
CREATE TABLE reminders (
  reminder_id  INT UNSIGNED NOT NULL AUTO_INCREMENT,
  task_id      INT UNSIGNED NOT NULL,
  user_id      INT UNSIGNED NOT NULL,
  reminder_at  DATETIME NOT NULL,
  is_sent      TINYINT(1) NOT NULL DEFAULT 0,
  PRIMARY KEY (reminder_id),
  KEY idx_reminders_due (is_sent, reminder_at),   -- untuk query pengingat yang belum terkirim
  KEY idx_reminders_task (task_id),
  KEY idx_reminders_user (user_id),
  CONSTRAINT fk_reminders_task
    FOREIGN KEY (task_id) REFERENCES tasks (task_id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_reminders_user
    FOREIGN KEY (user_id) REFERENCES users (user_id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;

-- -----------------------------------------------------
-- 7. task_activities  (riwayat aktivitas + fitur Ping US-12)
--    target_user_id hanya dipakai saat activity_type = 'ping'
-- -----------------------------------------------------
CREATE TABLE task_activities (
  activity_id     INT UNSIGNED NOT NULL AUTO_INCREMENT,
  task_id         INT UNSIGNED NOT NULL,
  user_id         INT UNSIGNED NOT NULL,          -- pelaku aktivitas
  activity_type   ENUM('created','updated','status_changed','completed','assigned','ping')
                  NOT NULL,
  target_user_id  INT UNSIGNED NULL,              -- penerima ping
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (activity_id),
  KEY idx_act_task (task_id, created_at),
  KEY idx_act_user (user_id),
  KEY idx_act_target (target_user_id),
  CONSTRAINT fk_act_task
    FOREIGN KEY (task_id) REFERENCES tasks (task_id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_act_user
    FOREIGN KEY (user_id) REFERENCES users (user_id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_act_target
    FOREIGN KEY (target_user_id) REFERENCES users (user_id)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB;


-- =====================================================
-- DATA CONTOH (opsional, untuk uji coba)
-- Password di bawah hanya placeholder, aplikasi nanti
-- harus menyimpan hash bcrypt asli.
-- =====================================================
INSERT INTO users (name, email, password) VALUES
  ('Ahmad Farel Febrian', 'farel@example.com', '$2b$10$placeholderhash1'),
  ('Luqman Hakim Al Faqih', 'luqman@example.com', '$2b$10$placeholderhash2');

INSERT INTO workspaces (owner_id, name, description) VALUES
  (1, 'Kelompok PjBL Mobile', 'Ruang kerja tugas kelompok Pemrograman Mobile');

INSERT INTO workspace_members (workspace_id, user_id, role) VALUES
  (1, 1, 'owner'),
  (1, 2, 'member');

INSERT INTO tasks (user_id, workspace_id, title, description, deadline, status, label_color) VALUES
  (1, NULL, 'Belajar React Native', 'Tugas pribadi', '2026-09-20 23:59:00', 'belum_dikerjakan', '#3498DB'),
  (1, 1,    'Dokumen Analisis Kebutuhan', 'Tugas kelompok', '2026-09-09 08:00:00', 'sedang_dikerjakan', '#E74C3C'),
  (1, 1,    'Desain Database', 'Tugas kelompok', '2026-09-12 23:59:00', 'belum_dikerjakan', '#2ECC71');

INSERT INTO task_assignments (task_id, user_id, completed_at) VALUES
  (2, 1, '2026-09-08 20:00:00'),
  (2, 2, NULL),
  (3, 2, NULL);

INSERT INTO reminders (task_id, user_id, reminder_at) VALUES
  (2, 1, '2026-09-08 08:00:00'),
  (3, 2, '2026-09-11 08:00:00');

INSERT INTO task_activities (task_id, user_id, activity_type, target_user_id) VALUES
  (2, 1, 'created', NULL),
  (2, 1, 'ping', 2);


-- =====================================================
-- CONTOH QUERY PENTING UNTUK FITUR APLIKASI
-- =====================================================

-- US-02 & US-07: daftar tugas user (pribadi + kelompok), urut deadline terdekat,
-- sekaligus hitung sisa waktu & penanda overdue. Ganti angka 1 dengan user_id yang login.
-- SELECT t.*,
--        TIMESTAMPDIFF(MINUTE, NOW(), t.deadline) AS sisa_menit,
--        (t.deadline < NOW() AND t.status <> 'selesai') AS is_overdue
-- FROM tasks t
-- LEFT JOIN workspace_members wm ON wm.workspace_id = t.workspace_id AND wm.user_id = 1
-- WHERE t.user_id = 1 OR wm.user_id IS NOT NULL
-- ORDER BY t.deadline ASC;

-- US-03: filter tugas yang belum selesai
-- SELECT * FROM tasks WHERE user_id = 1 AND status <> 'selesai' ORDER BY deadline ASC;

-- US-08: persentase progres tugas
-- SELECT ROUND(SUM(status = 'selesai') / COUNT(*) * 100, 1) AS persen_selesai
-- FROM tasks WHERE user_id = 1;

-- US-09: siapa saja yang sudah menyelesaikan bagian tugas kelompok
-- SELECT u.name, ta.completed_at
-- FROM task_assignments ta
-- JOIN users u ON u.user_id = ta.user_id
-- WHERE ta.task_id = 2;

-- US-04: pengingat yang sudah waktunya dikirim
-- SELECT r.*, u.push_token, t.title
-- FROM reminders r
-- JOIN users u ON u.user_id = r.user_id
-- JOIN tasks t ON t.task_id = r.task_id
-- WHERE r.is_sent = 0 AND r.reminder_at <= NOW() AND t.status <> 'selesai';
