-- MyWay автопостинг · схема БД v0.1 (MVP-1: публикатор и монитор)
CREATE TABLE IF NOT EXISTS posts (
    id             bigserial PRIMARY KEY,
    type           text        NOT NULL DEFAULT 'manual'
                   CHECK (type IN ('plan','news','manual')),
    body           text        NOT NULL,
    photo_file_id  text,
    source_url     text,
    status         text        NOT NULL DEFAULT 'draft'
                   CHECK (status IN ('draft','approved','publishing','published','failed','overdue','cancelled')),
    scheduled_at   timestamptz,
    published_at   timestamptz,
    tg_message_id  bigint,
    attempts       int         NOT NULL DEFAULT 0,
    last_error     text,
    legacy_id      int UNIQUE,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS posts_due_idx ON posts (status, scheduled_at);

CREATE TABLE IF NOT EXISTS publish_log (
    id             bigserial PRIMARY KEY,
    post_id        bigint      NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    attempted_at   timestamptz NOT NULL DEFAULT now(),
    result         text        NOT NULL CHECK (result IN ('ok','error')),
    error_text     text,
    tg_message_id  bigint,
    mode           text        NOT NULL CHECK (mode IN ('test','live'))
);

CREATE TABLE IF NOT EXISTS settings (
    key    text PRIMARY KEY,
    value  text NOT NULL
);

INSERT INTO settings (key, value) VALUES
    ('mode', 'test'),
    ('target_chat_id', '@my_way_finance'),
    ('admin_chat_id', '<ADMIN_TELEGRAM_ID>'),
    ('slot_plan', '19:05'),
    ('slot_news', '12:00'),
    ('timezone', 'Europe/Moscow'),
    ('overdue_minutes', '30'),
    ('max_attempts', '3')
ON CONFLICT (key) DO NOTHING;
