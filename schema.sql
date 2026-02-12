-- schema.sql - Database tables for Syntaxy

-- Users table
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(50) UNIQUE NOT NULL,
    password VARCHAR(255) NOT NULL,
    display_name VARCHAR(50),
    color VARCHAR(7) DEFAULT '#58a6ff',
    accent VARCHAR(7) DEFAULT '#3fb950',
    bio TEXT DEFAULT '',
    avatar TEXT DEFAULT '',
    banner TEXT DEFAULT '',
    created_at TIMESTAMP DEFAULT NOW()
);

-- Servers table
CREATE TABLE IF NOT EXISTS servers (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    icon VARCHAR(10) DEFAULT '',
    icon_img TEXT DEFAULT '',
    banner TEXT DEFAULT '',
    owner_id INTEGER REFERENCES users(id),
    accent VARCHAR(7) DEFAULT '#58a6ff',
    aesthetics JSONB DEFAULT '{"bg":"#0d1117","surface":"#161b22","acc1":"#58a6ff","acc2":"#3fb950","text":"#c9d1d9","border":"#30363d","sidebarStyle":"solid","sidebarGrad1":"#161b22","sidebarGrad2":"#1c2333"}',
    def_ch_bg TEXT DEFAULT '',
    created_at TIMESTAMP DEFAULT NOW()
);

-- Server members table
CREATE TABLE IF NOT EXISTS server_members (
    id SERIAL PRIMARY KEY,
    server_id INTEGER REFERENCES servers(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    is_admin BOOLEAN DEFAULT FALSE,
    joined_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(server_id, user_id)
);

-- Channels table
CREATE TABLE IF NOT EXISTS channels (
    id SERIAL PRIMARY KEY,
    server_id INTEGER REFERENCES servers(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    description TEXT DEFAULT '',
    background TEXT DEFAULT '',
    created_at TIMESTAMP DEFAULT NOW()
);

-- Messages table
CREATE TABLE IF NOT EXISTS messages (
    id SERIAL PRIMARY KEY,
    channel_id INTEGER REFERENCES channels(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    text TEXT,
    image TEXT,
    reply_to INTEGER,
    edited BOOLEAN DEFAULT FALSE,
    reactions JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT NOW()
);

-- DM channels table
CREATE TABLE IF NOT EXISTS dm_channels (
    id SERIAL PRIMARY KEY,
    user1_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    user2_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    background TEXT DEFAULT '',
    created_at TIMESTAMP DEFAULT NOW()
);

-- DM messages table
CREATE TABLE IF NOT EXISTS dm_messages (
    id SERIAL PRIMARY KEY,
    dm_channel_id INTEGER REFERENCES dm_channels(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    text TEXT,
    image TEXT,
    reply_to INTEGER,
    edited BOOLEAN DEFAULT FALSE,
    reactions JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT NOW()
);

-- Friends table
CREATE TABLE IF NOT EXISTS friends (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    friend_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    status VARCHAR(20) DEFAULT 'pending', -- pending, accepted
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(user_id, friend_id)
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id);
CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id);
CREATE INDEX IF NOT EXISTS idx_dm_messages_channel ON dm_messages(dm_channel_id);
CREATE INDEX IF NOT EXISTS idx_server_members_server ON server_members(server_id);
CREATE INDEX IF NOT EXISTS idx_server_members_user ON server_members(user_id);
CREATE INDEX IF NOT EXISTS idx_channels_server ON channels(server_id);
