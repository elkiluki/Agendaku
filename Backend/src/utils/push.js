import { Expo } from 'expo-server-sdk';
import { pool } from '../config/db.js';

const expo = new Expo();

// tokens: array string ExponentPushToken[...]
export async function sendPush(tokens, { title, body, data = {} }) {
  const messages = tokens
    .filter((t) => Expo.isExpoPushToken(t))
    .map((to) => ({ to, sound: 'default', title, body, data }));

  for (const chunk of expo.chunkPushNotifications(messages)) {
    try {
      await expo.sendPushNotificationsAsync(chunk);
    } catch (err) {
      console.error('Gagal mengirim push notification:', err.message);
    }
  }
}

export async function notifyUsers(userIds, payload) {
  if (!userIds.length) return;
  const [rows] = await pool.query(
    'SELECT push_token FROM users WHERE user_id IN (?) AND push_token IS NOT NULL',
    [userIds]
  );
  await sendPush(rows.map((r) => r.push_token), payload);
}
