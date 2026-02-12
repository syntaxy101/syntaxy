// server.js - Main backend server for Syntaxy with WebSocket support, AWS S3, and Friend System

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { WebSocketServer } = require('ws');

// AWS S3 Setup - NEW
const { S3Client } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3001;

// Create HTTP server
const server = http.createServer(app);

// Database connection
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// AWS S3 Client - NEW
const s3Client = new S3Client({
    region: process.env.AWS_REGION || 'us-east-1',
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
});

const S3_BUCKET = process.env.AWS_S3_BUCKET;

// Helper function to upload file to S3 - NEW
async function uploadToS3(file, folder = 'uploads') {
    const fileExtension = path.extname(file.originalname);
    const fileName = `${folder}/${crypto.randomBytes(16).toString('hex')}${fileExtension}`;

    const upload = new Upload({
        client: s3Client,
        params: {
            Bucket: S3_BUCKET,
            Key: fileName,
            Body: file.buffer,
            ContentType: file.mimetype,
            ACL: 'public-read' // Makes file publicly readable
        }
    });

    await upload.done();

    // Return the public URL
    return `https://${S3_BUCKET}.s3.${process.env.AWS_REGION || 'us-east-1'}.amazonaws.com/${fileName}`;
}

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// File upload configuration - UPDATED to use memory storage for S3
const upload = multer({
    storage: multer.memoryStorage(), // Store in memory instead of disk
                      limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

// ============================================
// AUTO-MIGRATION: Add settings columns if missing
// ============================================
(async () => {
    try {
        await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS gallery JSONB DEFAULT '{}'`);
        await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS personal_ui JSONB DEFAULT '{}'`);
        
        // Server invites table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS server_invites (
                id SERIAL PRIMARY KEY,
                server_id INTEGER REFERENCES servers(id) ON DELETE CASCADE,
                code VARCHAR(20) UNIQUE NOT NULL,
                created_by INTEGER REFERENCES users(id),
                uses INTEGER DEFAULT 0,
                max_uses INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT NOW()
            )
        `);
        
        console.log('Migration check complete');
    } catch (err) {
        console.error('Migration error:', err);
    }
})();

// Serve static frontend
app.use(express.static(path.join(__dirname, 'public')));

// ============================================
// WEBSOCKET SETUP
// ============================================

const wss = new WebSocketServer({ server });
const activeConnections = new Map();

function verifyWebSocketToken(token) {
    try {
        return jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
        return null;
    }
}

wss.on('connection', (ws, req) => {
    console.log('New WebSocket connection attempt');

    let userId = null;
    let username = null;

    ws.on('message', async (data) => {
        try {
            const message = JSON.parse(data.toString());

            // AUTHENTICATE
            if (message.type === 'authenticate') {
                const user = verifyWebSocketToken(message.token);
                if (!user) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Invalid token' }));
                    ws.close();
                    return;
                }

                userId = user.id;
                username = user.username;
                activeConnections.set(userId, ws);

                console.log(`User ${username} (ID: ${userId}) authenticated via WebSocket`);

                ws.send(JSON.stringify({
                    type: 'authenticated',
                    userId: userId,
                    username: username
                }));
                return;
            }

            // All other message types require authentication
            if (!userId) {
                ws.send(JSON.stringify({ type: 'error', message: 'Not authenticated' }));
                return;
            }

            // NEW MESSAGE
            if (message.type === 'new_message') {
                const { channelId, text, image, reply_to, isDM, dmChannelId } = message;

                let result, fullMessage;

                if (isDM) {
                    result = await pool.query(
                        `INSERT INTO dm_messages (dm_channel_id, user_id, text, image, reply_to, created_at)
                        VALUES ($1, $2, $3, $4, $5, NOW())
                        RETURNING *`,
                        [dmChannelId, userId, text || '', image || null, reply_to || null]
                    );

                    fullMessage = await pool.query(
                        `SELECT m.*, u.username, u.display_name, u.color, u.accent, u.avatar
                        FROM dm_messages m
                        JOIN users u ON m.user_id = u.id
                        WHERE m.id = $1`,
                        [result.rows[0].id]
                    );

                    const dmInfo = await pool.query(
                        `SELECT user1_id, user2_id FROM dm_channels WHERE id = $1`,
                        [dmChannelId]
                    );

                    if (dmInfo.rows.length > 0) {
                        const otherUserId = dmInfo.rows[0].user1_id === userId
                        ? dmInfo.rows[0].user2_id
                        : dmInfo.rows[0].user1_id;

                        [userId, otherUserId].forEach(id => {
                            const connection = activeConnections.get(id);
                            if (connection && connection.readyState === ws.OPEN) {
                                connection.send(JSON.stringify({
                                    type: 'dm_message',
                                    dmChannelId: dmChannelId,
                                    message: fullMessage.rows[0]
                                }));
                            }
                        });
                    }

                } else {
                    result = await pool.query(
                        `INSERT INTO messages (channel_id, user_id, text, image, reply_to, created_at)
                        VALUES ($1, $2, $3, $4, $5, NOW())
                        RETURNING *`,
                        [channelId, userId, text || '', image || null, reply_to || null]
                    );

                    fullMessage = await pool.query(
                        `SELECT m.*, u.username, u.display_name, u.color, u.accent, u.avatar
                        FROM messages m
                        JOIN users u ON m.user_id = u.id
                        WHERE m.id = $1`,
                        [result.rows[0].id]
                    );

                    const serverMembers = await pool.query(
                        `SELECT DISTINCT sm.user_id
                        FROM server_members sm
                        JOIN channels c ON c.server_id = sm.server_id
                        WHERE c.id = $1`,
                        [channelId]
                    );

                    serverMembers.rows.forEach(member => {
                        const connection = activeConnections.get(member.user_id);
                        if (connection && connection.readyState === ws.OPEN) {
                            connection.send(JSON.stringify({
                                type: 'channel_message',
                                channelId: channelId,
                                message: fullMessage.rows[0]
                            }));
                        }
                    });
                }

                console.log(`Message sent by ${username} in ${isDM ? 'DM' : 'channel'}`);
            }

            // MESSAGE EDIT
            if (message.type === 'edit_message') {
                const { messageId, text, isDM, channelId, dmChannelId } = message;

                if (isDM) {
                    const result = await pool.query(
                        `UPDATE dm_messages
                        SET text = $1, edited = true
                        WHERE id = $2 AND user_id = $3
                        RETURNING *`,
                        [text, messageId, userId]
                    );

                    if (result.rows.length > 0) {
                        const dmInfo = await pool.query(
                            `SELECT user1_id, user2_id FROM dm_channels WHERE id = $1`,
                            [dmChannelId]
                        );

                        if (dmInfo.rows.length > 0) {
                            const otherUserId = dmInfo.rows[0].user1_id === userId
                            ? dmInfo.rows[0].user2_id
                            : dmInfo.rows[0].user1_id;

                            [userId, otherUserId].forEach(id => {
                                const connection = activeConnections.get(id);
                                if (connection && connection.readyState === ws.OPEN) {
                                    connection.send(JSON.stringify({
                                        type: 'dm_message_edited',
                                        dmChannelId: dmChannelId,
                                        messageId: messageId,
                                        text: text
                                    }));
                                }
                            });
                        }
                    }
                } else {
                    const result = await pool.query(
                        `UPDATE messages
                        SET text = $1, edited = true
                        WHERE id = $2 AND user_id = $3
                        RETURNING *`,
                        [text, messageId, userId]
                    );

                    if (result.rows.length > 0) {
                        const serverMembers = await pool.query(
                            `SELECT DISTINCT sm.user_id
                            FROM server_members sm
                            JOIN channels c ON c.server_id = sm.server_id
                            WHERE c.id = $1`,
                            [channelId]
                        );

                        serverMembers.rows.forEach(member => {
                            const connection = activeConnections.get(member.user_id);
                            if (connection && connection.readyState === ws.OPEN) {
                                connection.send(JSON.stringify({
                                    type: 'message_edited',
                                    channelId: channelId,
                                    messageId: messageId,
                                    text: text
                                }));
                            }
                        });
                    }
                }
            }

            // MESSAGE DELETE
            if (message.type === 'delete_message') {
                const { messageId, isDM, channelId, dmChannelId } = message;

                if (isDM) {
                    const result = await pool.query(
                        'DELETE FROM dm_messages WHERE id = $1 AND user_id = $2 RETURNING id',
                        [messageId, userId]
                    );

                    if (result.rows.length > 0) {
                        const dmInfo = await pool.query(
                            `SELECT user1_id, user2_id FROM dm_channels WHERE id = $1`,
                            [dmChannelId]
                        );

                        if (dmInfo.rows.length > 0) {
                            const otherUserId = dmInfo.rows[0].user1_id === userId
                            ? dmInfo.rows[0].user2_id
                            : dmInfo.rows[0].user1_id;

                            [userId, otherUserId].forEach(id => {
                                const connection = activeConnections.get(id);
                                if (connection && connection.readyState === ws.OPEN) {
                                    connection.send(JSON.stringify({
                                        type: 'dm_message_deleted',
                                        dmChannelId: dmChannelId,
                                        messageId: messageId
                                    }));
                                }
                            });
                        }
                    }
                } else {
                    const result = await pool.query(
                        'DELETE FROM messages WHERE id = $1 AND user_id = $2 RETURNING id',
                        [messageId, userId]
                    );

                    if (result.rows.length > 0) {
                        const serverMembers = await pool.query(
                            `SELECT DISTINCT sm.user_id
                            FROM server_members sm
                            JOIN channels c ON c.server_id = sm.server_id
                            WHERE c.id = $1`,
                            [channelId]
                        );

                        serverMembers.rows.forEach(member => {
                            const connection = activeConnections.get(member.user_id);
                            if (connection && connection.readyState === ws.OPEN) {
                                connection.send(JSON.stringify({
                                    type: 'message_deleted',
                                    channelId: channelId,
                                    messageId: messageId
                                }));
                            }
                        });
                    }
                }
            }

            // PROFILE UPDATE BROADCAST
            if (message.type === 'profile_update') {
                const { user } = message;
                // Broadcast to all connected users except sender
                activeConnections.forEach((connection, connUserId) => {
                    if (connUserId !== userId && connection.readyState === ws.OPEN) {
                        connection.send(JSON.stringify({
                            type: 'profile_updated',
                            user: user
                        }));
                    }
                });
                console.log(`Profile update broadcast from ${username}`);
            }

            // DM BACKGROUND CHANGE
            if (message.type === 'dm_bg_change') {
                const { dmChannelId, background } = message;
                
                // Save to database
                await pool.query(
                    'UPDATE dm_channels SET background = $1 WHERE id = $2',
                    [background || '', dmChannelId]
                );
                
                // Insert system message
                const sysMsg = await pool.query(
                    `INSERT INTO dm_messages (dm_channel_id, user_id, text, image, reply_to, created_at)
                    VALUES ($1, $2, $3, NULL, NULL, NOW())
                    RETURNING *`,
                    [dmChannelId, userId, background ? '📷 changed the chat background' : '🗑️ removed the chat background']
                );
                
                const fullSysMsg = await pool.query(
                    `SELECT m.*, u.username, u.display_name, u.color, u.accent, u.avatar
                    FROM dm_messages m JOIN users u ON m.user_id = u.id WHERE m.id = $1`,
                    [sysMsg.rows[0].id]
                );
                
                // Get both users
                const dmInfo = await pool.query(
                    'SELECT user1_id, user2_id FROM dm_channels WHERE id = $1',
                    [dmChannelId]
                );
                
                if (dmInfo.rows.length > 0) {
                    const otherUserId = dmInfo.rows[0].user1_id === userId
                        ? dmInfo.rows[0].user2_id
                        : dmInfo.rows[0].user1_id;
                    
                    // Broadcast to both users
                    [userId, otherUserId].forEach(id => {
                        const connection = activeConnections.get(id);
                        if (connection && connection.readyState === ws.OPEN) {
                            connection.send(JSON.stringify({
                                type: 'dm_bg_changed',
                                dmChannelId: dmChannelId,
                                background: background || '',
                                changedBy: username
                            }));
                            // Also send the system message
                            connection.send(JSON.stringify({
                                type: 'dm_message',
                                dmChannelId: dmChannelId,
                                message: fullSysMsg.rows[0]
                            }));
                        }
                    });
                }
                console.log(`DM background changed by ${username}`);
            }

            // CHANNEL BACKGROUND CHANGE
            if (message.type === 'channel_bg_change') {
                const { channelId, background } = message;
                
                await pool.query(
                    'UPDATE channels SET background = $1 WHERE id = $2',
                    [background || '', channelId]
                );
                
                // Broadcast to all server members
                const serverMembers = await pool.query(
                    `SELECT DISTINCT sm.user_id
                    FROM server_members sm
                    JOIN channels c ON c.server_id = sm.server_id
                    WHERE c.id = $1`,
                    [channelId]
                );
                
                serverMembers.rows.forEach(member => {
                    const connection = activeConnections.get(member.user_id);
                    if (connection && connection.readyState === ws.OPEN) {
                        connection.send(JSON.stringify({
                            type: 'channel_bg_changed',
                            channelId: channelId,
                            background: background || ''
                        }));
                    }
                });
            }

            // SERVER AESTHETICS UPDATE
            if (message.type === 'server_aesthetics_update') {
                const { serverId, aesthetics, name, iconImg, banner, defChBg } = message;
                
                // Save to database
                await pool.query(
                    `UPDATE servers SET 
                        aesthetics = COALESCE($1, aesthetics),
                        name = COALESCE($2, name),
                        icon_img = COALESCE($3, icon_img),
                        banner = COALESCE($4, banner),
                        def_ch_bg = COALESCE($5, def_ch_bg)
                    WHERE id = $6`,
                    [aesthetics ? JSON.stringify(aesthetics) : null, name, iconImg, banner, defChBg, serverId]
                );
                
                // Broadcast to all server members
                const members = await pool.query(
                    'SELECT user_id FROM server_members WHERE server_id = $1',
                    [serverId]
                );
                
                members.rows.forEach(member => {
                    const connection = activeConnections.get(member.user_id);
                    if (connection && connection.readyState === ws.OPEN) {
                        connection.send(JSON.stringify({
                            type: 'server_aesthetics_updated',
                            serverId: serverId,
                            aesthetics: aesthetics,
                            name: name,
                            iconImg: iconImg,
                            banner: banner,
                            defChBg: defChBg
                        }));
                    }
                });
                console.log(`Server aesthetics updated by ${username}`);
            }

            // TYPING INDICATOR
            if (message.type === 'typing') {
                const { channelId, isDM, dmChannelId } = message;

                if (isDM) {
                    const dmInfo = await pool.query(
                        `SELECT user1_id, user2_id FROM dm_channels WHERE id = $1`,
                        [dmChannelId]
                    );

                    if (dmInfo.rows.length > 0) {
                        const otherUserId = dmInfo.rows[0].user1_id === userId
                        ? dmInfo.rows[0].user2_id
                        : dmInfo.rows[0].user1_id;

                        const connection = activeConnections.get(otherUserId);
                        if (connection && connection.readyState === ws.OPEN) {
                            connection.send(JSON.stringify({
                                type: 'user_typing',
                                dmChannelId: dmChannelId,
                                userId: userId,
                                username: username
                            }));
                        }
                    }
                } else {
                    const serverMembers = await pool.query(
                        `SELECT DISTINCT sm.user_id
                        FROM server_members sm
                        JOIN channels c ON c.server_id = sm.server_id
                        WHERE c.id = $1 AND sm.user_id != $2`,
                        [channelId, userId]
                    );

                    serverMembers.rows.forEach(member => {
                        const connection = activeConnections.get(member.user_id);
                        if (connection && connection.readyState === ws.OPEN) {
                            connection.send(JSON.stringify({
                                type: 'user_typing',
                                channelId: channelId,
                                userId: userId,
                                username: username
                            }));
                        }
                    });
                }
            }

        } catch (err) {
            console.error('WebSocket message error:', err);
            ws.send(JSON.stringify({ type: 'error', message: 'Server error' }));
        }
    });

    ws.on('close', () => {
        if (userId) {
            activeConnections.delete(userId);
            console.log(`User ${username} (ID: ${userId}) disconnected from WebSocket`);
        }
    });

    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
    });
});

console.log('WebSocket server initialized');

// ============================================
// AUTHENTICATION MIDDLEWARE
// ============================================

function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: 'No token provided' });
    }

    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) {
            return res.status(403).json({ error: 'Invalid token' });
        }
        req.user = user;
        next();
    });
}

// ============================================
// AUTH ROUTES
// ============================================

// Register
app.post('/api/auth/register', async (req, res) => {
    try {
        const { username, password, display_name } = req.body;

        if (!username || !password) {
            return res.status(400).json({ error: 'Username and password required' });
        }

        // Check if username exists
        const existing = await pool.query(
            'SELECT id FROM users WHERE LOWER(username) = LOWER($1)',
                                          [username]
        );

        if (existing.rows.length > 0) {
            return res.status(400).json({ error: 'Username already exists' });
        }

        // Hash password
        const hashedPassword = await bcrypt.hash(password, 10);

        // Create user
        const result = await pool.query(
            `INSERT INTO users (username, password, display_name, created_at)
            VALUES ($1, $2, $3, NOW())
            RETURNING id, username, display_name, color, accent, bio, avatar, banner`,
            [username, hashedPassword, display_name || username]
        );

        const user = result.rows[0];

        // Create token
        const token = jwt.sign({ id: user.id, username: user.username }, process.env.JWT_SECRET, {
            expiresIn: '7d'
        });

        res.json({ user, token });
    } catch (err) {
        console.error('Register error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Login
app.post('/api/auth/login', async (req, res) => {
    try {
        const { username, password } = req.body;

        const result = await pool.query(
            'SELECT * FROM users WHERE LOWER(username) = LOWER($1)',
                                        [username]
        );

        if (result.rows.length === 0) {
            return res.status(400).json({ error: 'User not found' });
        }

        const user = result.rows[0];
        const validPassword = await bcrypt.compare(password, user.password);

        if (!validPassword) {
            return res.status(400).json({ error: 'Incorrect password' });
        }

        const token = jwt.sign({ id: user.id, username: user.username }, process.env.JWT_SECRET, {
            expiresIn: '7d'
        });

        delete user.password;
        user.gallery = user.gallery || {};
        user.personal_ui = user.personal_ui || {};

        res.json({ user, token });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Get current user
app.get('/api/auth/me', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT id, username, display_name, color, accent, bio, avatar, banner, gallery FROM users WHERE id = $1',
            [req.params.id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        const user = result.rows[0];
        user.gallery = user.gallery || {};
        user.personal_ui = user.personal_ui || {};
        res.json(user);
    } catch (err) {
        console.error('Get me error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ============================================
// USER ROUTES
// ============================================

// Update profile
app.put('/api/users/profile', authenticateToken, async (req, res) => {
    try {
        const { display_name, bio, color, accent, avatar, banner, gallery, personal_ui } = req.body;

        const result = await pool.query(
            `UPDATE users
            SET display_name = COALESCE($1, display_name),
                                        bio = COALESCE($2, bio),
                                        color = COALESCE($3, color),
                                        accent = COALESCE($4, accent),
                                        avatar = COALESCE($5, avatar),
                                        banner = COALESCE($6, banner),
                                        gallery = COALESCE($7, gallery),
                                        personal_ui = COALESCE($8, personal_ui)
                                        WHERE id = $9
                                        RETURNING id, username, display_name, color, accent, bio, avatar, banner, gallery, personal_ui`,
                                        [display_name, bio, color, accent, avatar, banner,
                                        gallery ? JSON.stringify(gallery) : null,
                                        personal_ui ? JSON.stringify(personal_ui) : null,
                                        req.user.id]
        );

        res.json(result.rows[0]);
    } catch (err) {
        console.error('Update profile error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Save user settings
app.put('/api/users/settings', authenticateToken, async (req, res) => {
    try {
        const { gallery, personal_ui } = req.body;

        const updates = [];
        const values = [];
        let paramCount = 1;

        if (gallery !== undefined) {
            updates.push(`gallery = $${paramCount}`);
            values.push(JSON.stringify(gallery));
            paramCount++;
        }

        if (personal_ui !== undefined) {
            updates.push(`personal_ui = $${paramCount}`);
            values.push(JSON.stringify(personal_ui));
            paramCount++;
        }

        if (updates.length === 0) {
            return res.status(400).json({ error: 'No settings to update' });
        }

        values.push(req.user.id);

        const result = await pool.query(
            `UPDATE users SET ${updates.join(', ')} WHERE id = $${paramCount} RETURNING gallery, personal_ui`,
                                        values
        );

        res.json(result.rows[0]);
    } catch (err) {
        console.error('Save settings error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Search users (frontend calls /api/users/search?q=...)
app.get('/api/users/search', authenticateToken, async (req, res) => {
    try {
        const { q } = req.query;

        if (!q || q.length < 1) {
            return res.json([]);
        }

        const result = await pool.query(
            `SELECT id, username, display_name, avatar, color
            FROM users
            WHERE (LOWER(username) LIKE LOWER($1) OR LOWER(display_name) LIKE LOWER($1))
            AND id != $2
            LIMIT 20`,
            [`%${q}%`, req.user.id]
        );

        res.json(result.rows);
    } catch (err) {
        console.error('Search users error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Get user by ID (must be AFTER /users/search so "search" doesn't match :id)
app.get('/api/users/:id', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT id, username, display_name, color, accent, bio, avatar, banner, gallery FROM users WHERE id = $1',
            [req.params.id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        res.json(result.rows[0]);
    } catch (err) {
        console.error('Get user error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/users', authenticateToken, async (req, res) => {
    try {
        const { q } = req.query;

        if (!q || q.length < 2) {
            return res.json([]);
        }

        const result = await pool.query(
            `SELECT id, username, display_name, avatar, color
            FROM users
            WHERE (LOWER(username) LIKE LOWER($1) OR LOWER(display_name) LIKE LOWER($1))
            AND id != $2
            LIMIT 20`,
            [`%${q}%`, req.user.id]
        );

        res.json(result.rows);
    } catch (err) {
        console.error('Search users error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Shortcut: /api/me -> same as /api/auth/me (frontend calls this)
app.get('/api/me', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT id, username, display_name, color, accent, bio, avatar, banner, gallery, personal_ui FROM users WHERE id = $1',
            [req.user.id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        const user = result.rows[0];
        user.gallery = user.gallery || {};
        user.personal_ui = user.personal_ui || {};
        res.json(user);
    } catch (err) {
        console.error('Get me error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ============================================
// FRIEND ROUTES
// ============================================

// Get friendship status with a specific user (used by search results)
app.get('/api/friends/status/:userId', authenticateToken, async (req, res) => {
    try {
        const otherUserId = parseInt(req.params.userId);

        const result = await pool.query(
            `SELECT * FROM friends
            WHERE (user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1)`,
                                        [req.user.id, otherUserId]
        );

        if (result.rows.length === 0) {
            return res.json({ status: 'none' });
        }

        const row = result.rows[0];

        if (row.status === 'accepted') {
            return res.json({ status: 'accepted', requestId: row.id });
        }

        // Pending - determine direction
        if (row.user_id === req.user.id) {
            return res.json({ status: 'pending_sent', requestId: row.id });
        } else {
            return res.json({ status: 'pending_received', requestId: row.id });
        }
    } catch (err) {
        console.error('Get friend status error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Send friend request (frontend sends { friendId })
app.post('/api/friends/request', authenticateToken, async (req, res) => {
    try {
        // Accept both friendId (frontend) and friend_id
        const friend_id = req.body.friendId || req.body.friend_id;

        if (!friend_id) {
            return res.status(400).json({ error: 'Friend ID required' });
        }

        if (friend_id === req.user.id) {
            return res.status(400).json({ error: 'Cannot send friend request to yourself' });
        }

        const friendCheck = await pool.query(
            'SELECT id FROM users WHERE id = $1',
            [friend_id]
        );

        if (friendCheck.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        const existing = await pool.query(
            `SELECT * FROM friends
            WHERE (user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1)`,
                                          [req.user.id, friend_id]
        );

        if (existing.rows.length > 0) {
            return res.status(400).json({ error: 'Friend request already exists' });
        }

        const result = await pool.query(
            `INSERT INTO friends (user_id, friend_id, status, created_at)
            VALUES ($1, $2, 'pending', NOW())
            RETURNING *`,
            [req.user.id, friend_id]
        );

        res.json(result.rows[0]);
    } catch (err) {
        console.error('Send friend request error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Accept friend request (frontend calls /api/friends/request/:id/accept)
app.put('/api/friends/request/:id/accept', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(
            `UPDATE friends
            SET status = 'accepted'
            WHERE id = $1 AND friend_id = $2 AND status = 'pending'
            RETURNING *`,
            [req.params.id, req.user.id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Friend request not found' });
        }

        res.json(result.rows[0]);
    } catch (err) {
        console.error('Accept friend request error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Also support the shorter URL pattern
app.put('/api/friends/:id/accept', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(
            `UPDATE friends
            SET status = 'accepted'
            WHERE id = $1 AND friend_id = $2 AND status = 'pending'
            RETURNING *`,
            [req.params.id, req.user.id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Friend request not found' });
        }

        res.json(result.rows[0]);
    } catch (err) {
        console.error('Accept friend request error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Decline/Remove friend request (frontend calls /api/friends/request/:id)
app.delete('/api/friends/request/:id', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(
            `DELETE FROM friends
            WHERE id = $1 AND (user_id = $2 OR friend_id = $2)
            RETURNING id`,
            [req.params.id, req.user.id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Friend request not found' });
        }

        res.json({ success: true });
    } catch (err) {
        console.error('Delete friend error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Also support shorter URL pattern
app.delete('/api/friends/:id', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(
            `DELETE FROM friends
            WHERE id = $1 AND (user_id = $2 OR friend_id = $2)
            RETURNING id`,
            [req.params.id, req.user.id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Friend request not found' });
        }

        res.json({ success: true });
    } catch (err) {
        console.error('Delete friend error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Get user's friends and pending requests
// Frontend calls both /api/friends AND /api/friends/requests
app.get('/api/friends/requests', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT f.*,
            u1.username as user_username, u1.display_name as user_display_name, u1.avatar as user_avatar, u1.color as user_color,
            u2.username as friend_username, u2.display_name as friend_display_name, u2.avatar as friend_avatar, u2.color as friend_color
            FROM friends f
            JOIN users u1 ON f.user_id = u1.id
            JOIN users u2 ON f.friend_id = u2.id
            WHERE (f.user_id = $1 OR f.friend_id = $1)
            ORDER BY f.created_at DESC`,
            [req.user.id]
        );

        const friends = result.rows.map(row => {
            const isRequester = row.user_id === req.user.id;
            return {
                id: row.id,
                status: row.status,
                created_at: row.created_at,
                user_id: row.user_id,
                friend_id: row.friend_id,
                isRequester: isRequester,
                user: {
                    id: isRequester ? row.friend_id : row.user_id,
                    username: isRequester ? row.friend_username : row.user_username,
                    display_name: isRequester ? row.friend_display_name : row.user_display_name,
                    avatar: isRequester ? row.friend_avatar : row.user_avatar,
                    color: isRequester ? row.friend_color : row.user_color
                }
            };
        });

        res.json(friends);
    } catch (err) {
        console.error('Get friends error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/friends', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT f.*,
            u1.username as user_username, u1.display_name as user_display_name, u1.avatar as user_avatar, u1.color as user_color,
            u2.username as friend_username, u2.display_name as friend_display_name, u2.avatar as friend_avatar, u2.color as friend_color
            FROM friends f
            JOIN users u1 ON f.user_id = u1.id
            JOIN users u2 ON f.friend_id = u2.id
            WHERE f.user_id = $1 OR f.friend_id = $1
            ORDER BY f.created_at DESC`,
            [req.user.id]
        );

        const friends = result.rows.map(row => {
            const isRequester = row.user_id === req.user.id;
            return {
                id: row.id,
                status: row.status,
                created_at: row.created_at,
                isRequester: isRequester,
                user: {
                    id: isRequester ? row.friend_id : row.user_id,
                    username: isRequester ? row.friend_username : row.user_username,
                    display_name: isRequester ? row.friend_display_name : row.user_display_name,
                    avatar: isRequester ? row.friend_avatar : row.user_avatar,
                    color: isRequester ? row.friend_color : row.user_color
                }
            };
        });

        res.json(friends);
    } catch (err) {
        console.error('Get friends error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Get user's servers
app.get('/api/servers', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT s.*
            FROM servers s
            JOIN server_members sm ON s.id = sm.server_id
            WHERE sm.user_id = $1
            ORDER BY s.created_at`,
            [req.user.id]
        );
        res.json(result.rows);
    } catch (err) {
        console.error('Get servers error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Create server
app.post('/api/servers', authenticateToken, async (req, res) => {
    try {
        const { name, icon, accent } = req.body;

        if (!name || !name.trim()) {
            return res.status(400).json({ error: 'Server name required' });
        }

        // Create the server
        const result = await pool.query(
            `INSERT INTO servers (name, icon, owner_id, accent, created_at)
            VALUES ($1, $2, $3, $4, NOW())
            RETURNING *`,
            [name.trim(), icon || name.trim()[0], req.user.id, accent || '#58a6ff']
        );

        const server = result.rows[0];

        // Add creator as admin member
        await pool.query(
            `INSERT INTO server_members (server_id, user_id, is_admin, joined_at)
            VALUES ($1, $2, true, NOW())`,
                         [server.id, req.user.id]
        );

        // Create default "general" channel
        await pool.query(
            `INSERT INTO channels (server_id, name, description, created_at)
            VALUES ($1, 'general', 'General discussion', NOW())`,
                         [server.id]
        );

        res.json(server);
    } catch (err) {
        console.error('Create server error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Get server by ID
app.get('/api/servers/:id', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT s.*
            FROM servers s
            JOIN server_members sm ON s.id = sm.server_id
            WHERE s.id = $1 AND sm.user_id = $2`,
            [req.params.id, req.user.id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Server not found' });
        }

        res.json(result.rows[0]);
    } catch (err) {
        console.error('Get server error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Update server
app.put('/api/servers/:id', authenticateToken, async (req, res) => {
    try {
        const { name, icon, icon_img, banner, accent, aesthetics, def_ch_bg } = req.body;

        const memberCheck = await pool.query(
            'SELECT is_admin FROM server_members WHERE server_id = $1 AND user_id = $2',
            [req.params.id, req.user.id]
        );

        if (memberCheck.rows.length === 0 || !memberCheck.rows[0].is_admin) {
            return res.status(403).json({ error: 'Not authorized' });
        }

        const result = await pool.query(
            `UPDATE servers
            SET name = COALESCE($1, name),
                                        icon = COALESCE($2, icon),
                                        icon_img = COALESCE($3, icon_img),
                                        banner = COALESCE($4, banner),
                                        accent = COALESCE($5, accent),
                                        aesthetics = COALESCE($6, aesthetics),
                                        def_ch_bg = COALESCE($7, def_ch_bg)
                                        WHERE id = $8
                                        RETURNING *`,
                                        [name, icon, icon_img, banner, accent,
                                        aesthetics ? JSON.stringify(aesthetics) : null,
                                        def_ch_bg,
                                        req.params.id]
        );

        res.json(result.rows[0]);
    } catch (err) {
        console.error('Update server error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Delete server
app.delete('/api/servers/:id', authenticateToken, async (req, res) => {
    try {
        const serverCheck = await pool.query(
            'SELECT owner_id FROM servers WHERE id = $1',
            [req.params.id]
        );

        if (serverCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Server not found' });
        }

        if (serverCheck.rows[0].owner_id !== req.user.id) {
            return res.status(403).json({ error: 'Only server owner can delete' });
        }

        await pool.query('DELETE FROM servers WHERE id = $1', [req.params.id]);

        res.json({ success: true });
    } catch (err) {
        console.error('Delete server error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Join server
app.post('/api/servers/:id/join', authenticateToken, async (req, res) => {
    try {
        const serverCheck = await pool.query('SELECT id FROM servers WHERE id = $1', [req.params.id]);

        if (serverCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Server not found' });
        }

        const memberCheck = await pool.query(
            'SELECT id FROM server_members WHERE server_id = $1 AND user_id = $2',
            [req.params.id, req.user.id]
        );

        if (memberCheck.rows.length > 0) {
            return res.status(400).json({ error: 'Already a member' });
        }

        await pool.query(
            `INSERT INTO server_members (server_id, user_id, is_admin, joined_at)
            VALUES ($1, $2, false, NOW())`,
                         [req.params.id, req.user.id]
        );

        res.json({ success: true });
    } catch (err) {
        console.error('Join server error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Leave server
app.post('/api/servers/:id/leave', authenticateToken, async (req, res) => {
    try {
        const serverCheck = await pool.query(
            'SELECT owner_id FROM servers WHERE id = $1',
            [req.params.id]
        );

        if (serverCheck.rows.length > 0 && serverCheck.rows[0].owner_id === req.user.id) {
            return res.status(400).json({ error: 'Owner cannot leave. Delete server or transfer ownership.' });
        }

        await pool.query(
            'DELETE FROM server_members WHERE server_id = $1 AND user_id = $2',
            [req.params.id, req.user.id]
        );

        res.json({ success: true });
    } catch (err) {
        console.error('Leave server error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Get server members
app.get('/api/servers/:id/members', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT u.id as user_id, u.username, u.display_name, u.avatar, u.color, u.accent, sm.is_admin, sm.joined_at
            FROM users u
            JOIN server_members sm ON u.id = sm.user_id
            WHERE sm.server_id = $1
            ORDER BY sm.is_admin DESC, sm.joined_at`,
            [req.params.id]
        );

        res.json(result.rows);
    } catch (err) {
        console.error('Get server members error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ============================================
// SERVER INVITE ROUTES
// ============================================

// Generate invite code
app.post('/api/servers/:id/invites', authenticateToken, async (req, res) => {
    try {
        const memberCheck = await pool.query(
            'SELECT is_admin FROM server_members WHERE server_id = $1 AND user_id = $2',
            [req.params.id, req.user.id]
        );
        if (memberCheck.rows.length === 0) {
            return res.status(403).json({ error: 'Not a member' });
        }
        
        // Generate a random 8-char code
        const code = crypto.randomBytes(4).toString('hex');
        
        const result = await pool.query(
            `INSERT INTO server_invites (server_id, code, created_by, created_at)
            VALUES ($1, $2, $3, NOW())
            RETURNING *`,
            [req.params.id, code, req.user.id]
        );
        
        res.json(result.rows[0]);
    } catch (err) {
        console.error('Create invite error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Get server info from invite code
app.get('/api/invites/:code', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT si.*, s.name as server_name, s.icon, s.icon_img, s.banner,
                (SELECT COUNT(*) FROM server_members WHERE server_id = s.id) as member_count
            FROM server_invites si
            JOIN servers s ON si.server_id = s.id
            WHERE si.code = $1`,
            [req.params.code]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Invalid invite code' });
        }
        
        const invite = result.rows[0];
        
        // Check if already a member
        const memberCheck = await pool.query(
            'SELECT id FROM server_members WHERE server_id = $1 AND user_id = $2',
            [invite.server_id, req.user.id]
        );
        
        res.json({
            ...invite,
            already_member: memberCheck.rows.length > 0
        });
    } catch (err) {
        console.error('Get invite error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Join server via invite code
app.post('/api/invites/:code/join', authenticateToken, async (req, res) => {
    try {
        const invite = await pool.query(
            `SELECT si.*, s.name as server_name FROM server_invites si
            JOIN servers s ON si.server_id = s.id
            WHERE si.code = $1`,
            [req.params.code]
        );
        
        if (invite.rows.length === 0) {
            return res.status(404).json({ error: 'Invalid invite code' });
        }
        
        const serverId = invite.rows[0].server_id;
        
        // Check if already a member
        const memberCheck = await pool.query(
            'SELECT id FROM server_members WHERE server_id = $1 AND user_id = $2',
            [serverId, req.user.id]
        );
        
        if (memberCheck.rows.length > 0) {
            return res.status(400).json({ error: 'Already a member' });
        }
        
        // Join
        await pool.query(
            `INSERT INTO server_members (server_id, user_id, is_admin, joined_at)
            VALUES ($1, $2, false, NOW())`,
            [serverId, req.user.id]
        );
        
        // Increment uses
        await pool.query(
            'UPDATE server_invites SET uses = uses + 1 WHERE id = $1',
            [invite.rows[0].id]
        );
        
        // Return full server data
        const server = await pool.query('SELECT * FROM servers WHERE id = $1', [serverId]);
        const channels = await pool.query(
            'SELECT * FROM channels WHERE server_id = $1 ORDER BY created_at',
            [serverId]
        );
        
        res.json({ server: server.rows[0], channels: channels.rows });
    } catch (err) {
        console.error('Join via invite error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ============================================
// CHANNEL ROUTES
// ============================================

// Create channel
app.post('/api/servers/:serverId/channels', authenticateToken, async (req, res) => {
    try {
        const { name, description, background } = req.body;

        const memberCheck = await pool.query(
            'SELECT is_admin FROM server_members WHERE server_id = $1 AND user_id = $2',
            [req.params.serverId, req.user.id]
        );

        if (memberCheck.rows.length === 0 || !memberCheck.rows[0].is_admin) {
            return res.status(403).json({ error: 'Not authorized' });
        }

        const result = await pool.query(
            `INSERT INTO channels (server_id, name, description, background, created_at)
            VALUES ($1, $2, $3, $4, NOW())
            RETURNING *`,
            [req.params.serverId, name, description || '', background || '']
        );

        res.json(result.rows[0]);
    } catch (err) {
        console.error('Create channel error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Get server channels
app.get('/api/servers/:serverId/channels', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT c.*
            FROM channels c
            JOIN server_members sm ON c.server_id = sm.server_id
            WHERE c.server_id = $1 AND sm.user_id = $2
            ORDER BY c.created_at`,
            [req.params.serverId, req.user.id]
        );

        res.json(result.rows);
    } catch (err) {
        console.error('Get channels error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Update channel
app.put('/api/channels/:id', authenticateToken, async (req, res) => {
    try {
        const { name, description, background } = req.body;

        const memberCheck = await pool.query(
            `SELECT sm.is_admin
            FROM server_members sm
            JOIN channels c ON c.server_id = sm.server_id
            WHERE c.id = $1 AND sm.user_id = $2`,
            [req.params.id, req.user.id]
        );

        if (memberCheck.rows.length === 0 || !memberCheck.rows[0].is_admin) {
            return res.status(403).json({ error: 'Not authorized' });
        }

        const result = await pool.query(
            `UPDATE channels
            SET name = COALESCE($1, name),
                                        description = COALESCE($2, description),
                                        background = COALESCE($3, background)
                                        WHERE id = $4
                                        RETURNING *`,
                                        [name, description, background, req.params.id]
        );

        res.json(result.rows[0]);
    } catch (err) {
        console.error('Update channel error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Delete channel
app.delete('/api/channels/:id', authenticateToken, async (req, res) => {
    try {
        const memberCheck = await pool.query(
            `SELECT sm.is_admin
            FROM server_members sm
            JOIN channels c ON c.server_id = sm.server_id
            WHERE c.id = $1 AND sm.user_id = $2`,
            [req.params.id, req.user.id]
        );

        if (memberCheck.rows.length === 0 || !memberCheck.rows[0].is_admin) {
            return res.status(403).json({ error: 'Not authorized' });
        }

        await pool.query('DELETE FROM channels WHERE id = $1', [req.params.id]);

        res.json({ success: true });
    } catch (err) {
        console.error('Delete channel error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ============================================
// MESSAGE ROUTES
// ============================================

// Get channel messages
app.get('/api/channels/:channelId/messages', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT m.*, u.username, u.display_name, u.color, u.accent, u.avatar
            FROM messages m
            JOIN users u ON m.user_id = u.id
            WHERE m.channel_id = $1
            ORDER BY m.created_at ASC
            LIMIT 100`,
            [req.params.channelId]
        );
        res.json(result.rows);
    } catch (err) {
        console.error('Get messages error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Send message (fallback for non-WebSocket clients)
app.post('/api/channels/:channelId/messages', authenticateToken, async (req, res) => {
    try {
        const { text, image, reply_to } = req.body;

        const result = await pool.query(
            `INSERT INTO messages (channel_id, user_id, text, image, reply_to, created_at)
            VALUES ($1, $2, $3, $4, $5, NOW())
            RETURNING *`,
            [req.params.channelId, req.user.id, text || '', image || null, reply_to || null]
        );

        const fullMessage = await pool.query(
            `SELECT m.*, u.username, u.display_name, u.color, u.accent, u.avatar
            FROM messages m
            JOIN users u ON m.user_id = u.id
            WHERE m.id = $1`,
            [result.rows[0].id]
        );

        res.json(fullMessage.rows[0]);
    } catch (err) {
        console.error('Send message error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Edit message
app.put('/api/messages/:id', authenticateToken, async (req, res) => {
    try {
        const { text } = req.body;

        const result = await pool.query(
            `UPDATE messages
            SET text = $1, edited = true
            WHERE id = $2 AND user_id = $3
            RETURNING *`,
            [text, req.params.id, req.user.id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Message not found or not authorized' });
        }

        res.json(result.rows[0]);
    } catch (err) {
        console.error('Edit message error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Delete message
app.delete('/api/messages/:id', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(
            'DELETE FROM messages WHERE id = $1 AND user_id = $2 RETURNING id',
            [req.params.id, req.user.id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Message not found or not authorized' });
        }

        res.json({ success: true });
    } catch (err) {
        console.error('Delete message error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Add reaction
app.post('/api/messages/:id/reactions', authenticateToken, async (req, res) => {
    try {
        const { emoji } = req.body;

        const message = await pool.query('SELECT reactions FROM messages WHERE id = $1', [req.params.id]);

        if (message.rows.length === 0) {
            return res.status(404).json({ error: 'Message not found' });
        }

        let reactions = message.rows[0].reactions || {};

        if (!reactions[emoji]) {
            reactions[emoji] = [];
        }

        if (!reactions[emoji].includes(req.user.id)) {
            reactions[emoji].push(req.user.id);
        } else {
            reactions[emoji] = reactions[emoji].filter(id => id !== req.user.id);
            if (reactions[emoji].length === 0) {
                delete reactions[emoji];
            }
        }

        await pool.query(
            'UPDATE messages SET reactions = $1 WHERE id = $2',
            [JSON.stringify(reactions), req.params.id]
        );

        res.json({ reactions });
    } catch (err) {
        console.error('Add reaction error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ============================================
// DM ROUTES
// ============================================

// Get or create DM channel
app.post('/api/dms', authenticateToken, async (req, res) => {
    try {
        const { otherUserId } = req.body;

        const existing = await pool.query(
            `SELECT * FROM dm_channels
            WHERE (user1_id = $1 AND user2_id = $2) OR (user1_id = $2 AND user2_id = $1)`,
                                          [req.user.id, otherUserId]
        );

        if (existing.rows.length > 0) {
            return res.json(existing.rows[0]);
        }

        const result = await pool.query(
            `INSERT INTO dm_channels (user1_id, user2_id, created_at)
            VALUES ($1, $2, NOW())
            RETURNING *`,
            [req.user.id, otherUserId]
        );

        res.json(result.rows[0]);
    } catch (err) {
        console.error('Create DM error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Get user's DMs
app.get('/api/dms', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT dc.*,
            u1.username as user1_username, u1.display_name as user1_display_name, u1.avatar as user1_avatar, u1.color as user1_color,
            u2.username as user2_username, u2.display_name as user2_display_name, u2.avatar as user2_avatar, u2.color as user2_color
            FROM dm_channels dc
            JOIN users u1 ON dc.user1_id = u1.id
            JOIN users u2 ON dc.user2_id = u2.id
            WHERE dc.user1_id = $1 OR dc.user2_id = $1
            ORDER BY dc.created_at`,
            [req.user.id]
        );
        res.json(result.rows);
    } catch (err) {
        console.error('Get DMs error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Get DM messages
app.get('/api/dms/:dmId/messages', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT m.*, u.username, u.display_name, u.color, u.accent, u.avatar
            FROM dm_messages m
            JOIN users u ON m.user_id = u.id
            WHERE m.dm_channel_id = $1
            ORDER BY m.created_at ASC
            LIMIT 100`,
            [req.params.dmId]
        );
        res.json(result.rows);
    } catch (err) {
        console.error('Get DM messages error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Send DM message
app.post('/api/dms/:dmId/messages', authenticateToken, async (req, res) => {
    try {
        const { text, image, reply_to } = req.body;

        const result = await pool.query(
            `INSERT INTO dm_messages (dm_channel_id, user_id, text, image, reply_to, created_at)
            VALUES ($1, $2, $3, $4, $5, NOW())
            RETURNING *`,
            [req.params.dmId, req.user.id, text || '', image || null, reply_to || null]
        );

        const fullMessage = await pool.query(
            `SELECT m.*, u.username, u.display_name, u.color, u.accent, u.avatar
            FROM dm_messages m
            JOIN users u ON m.user_id = u.id
            WHERE m.id = $1`,
            [result.rows[0].id]
        );

        res.json(fullMessage.rows[0]);
    } catch (err) {
        console.error('Send DM message error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ============================================
// FILE UPLOAD ROUTE - UPDATED FOR AWS S3
// ============================================

app.post('/api/upload', authenticateToken, upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }

        // Upload to S3
        const s3Url = await uploadToS3(req.file, 'uploads');

        console.log('File uploaded to S3:', s3Url);
        res.json({ url: s3Url });
    } catch (err) {
        console.error('Upload error:', err);
        res.status(500).json({ error: 'Upload failed' });
    }
});

// SPA catch-all
app.use((req, res, next) => {
    if (!req.path.startsWith('/api')) {
        res.sendFile(path.join(__dirname, 'public', 'index.html'));
    } else {
        next();
    }
});

// ============================================
// START SERVER
// ============================================

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`WebSocket server ready`);
    console.log(`AWS S3 configured for bucket: ${S3_BUCKET}`);
});

