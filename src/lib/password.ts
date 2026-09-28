// Password hashing (bcrypt, cost 10) and the password policy from security.md §3.
import bcrypt from "bcryptjs";

const COMMON = new Set(
  (
    "123456 password 12345678 qwerty 123456789 12345 1234 111111 1234567 dragon 123123 baseball abc123 football monkey " +
    "letmein 696969 shadow master 666666 qwertyuiop 123321 mustang 1234567890 michael 654321 pussy superman 1qaz2wsx " +
    "7777777 fuckyou 121212 000000 qazwsx 123qwe killer trustno1 jordan jennifer zxcvbnm asdfgh hunter buster soccer " +
    "harley batman andrew tigger sunshine iloveyou fuckme 2000 charlie robert thomas hockey ranger daniel starwars " +
    "klaster 112233 george asshole computer michelle jessica pepper 1111 zxcvbn 555555 11111111 131313 freedom 777777 " +
    "pass maggie 159753 aaaaaa ginger princess joshua cheese amanda summer love ashley 6969 nicole chelsea biteme " +
    "matthew access yankees 987654321 dallas austin thunder taylor matrix password1 password12 password123 welcome " +
    "welcome1 welcome123 admin admin123 administrator changeme changeme123 qwerty123 qwerty1234 1q2w3e4r 1q2w3e4r5t " +
    "zaq12wsx passw0rd p@ssw0rd p@ssword letmein123 iloveyou1 abcd1234 abcdefgh abcdefghij 0123456789 9876543210 " +
    "1111111111 0000000000 1234512345 qwertyuiop1 asdfghjkl asdfghjkl1 zxcvbnm123 monkey123 dragon123 football1 " +
    "baseball1 sunshine1 princess1 superman1 starwars1 trustno11 whatever whatever1 secret secret123 wachtwoord " +
    "wachtwoord1 welkom welkom123 geheim passwort passwort1 motdepasse azerty azerty123 contrasena contraseña " +
    "photopilot openbrandexchange brandportal beeldbank kestrel"
  ).split(/\s+/),
);

export function passwordProblem(pw: unknown): string | null {
  if (typeof pw !== "string") return "Password is required.";
  if (pw.length < 10) return "Use at least 10 characters.";
  if (pw.length > 72) return "Use at most 72 characters.";
  if (COMMON.has(pw.toLowerCase())) return "This password is too common. Choose another one.";
  if (/^(.)\1+$/.test(pw)) return "This password is too easy to guess.";
  return null;
}

declare const Bun: { password: { hash(p: string, o: unknown): Promise<string>; verify(p: string, h: string): Promise<boolean> } } | undefined;

const hasBun = typeof Bun !== "undefined" && !!Bun?.password;

/** argon2id (m=19 MiB, t=2) on Bun (native); bcrypt cost 10 on Workers (no native argon2 there). */
export async function hashPassword(pw: string): Promise<string> {
  if (hasBun) return Bun!.password.hash(pw, { algorithm: "argon2id", memoryCost: 19456, timeCost: 2 });
  return bcrypt.hashSync(pw, 10);
}

let dummy: string | null = null;

/** Verifies argon2id or bcrypt hashes; unknown users are checked against a dummy hash (similar timing). */
export async function verifyPassword(pw: string, hash: string | null | undefined): Promise<boolean> {
  dummy ??= await hashPassword("dummy password for timing");
  const h = hash ?? dummy;
  let ok = false;
  try {
    if (hasBun) ok = await Bun!.password.verify(pw, h);
    else ok = h.startsWith("$2") ? bcrypt.compareSync(pw, h) : false;
  } catch {
    ok = false;
  }
  return ok && !!hash;
}
