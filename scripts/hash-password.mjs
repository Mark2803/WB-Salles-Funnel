// Создаёт хэш пароля для ADMIN_PASSWORD_HASH и случайный SESSION_SECRET.
// Запуск: npm run hash-password  (пароль вводится с клавиатуры и не сохраняется)
import crypto from 'node:crypto';
import readline from 'node:readline';
import { hashPassword } from '../src/auth.mjs';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question('Придумайте пароль для входа (не короче 10 символов): ', (password) => {
  rl.close();
  if (!password || password.length < 10) {
    console.error('Пароль слишком короткий.');
    process.exit(1);
  }
  console.log('\nДобавьте в файл .env эти две строки:\n');
  console.log(`ADMIN_PASSWORD_HASH=${hashPassword(password)}`);
  console.log(`SESSION_SECRET=${crypto.randomBytes(32).toString('base64url')}`);
});
