import { google } from 'googleapis';
import { AppConfig } from '../../config/env';
import { OutreachDb } from '../../db/types';
import { AppError } from '../../utils/errors';
import { decryptString, encryptString, randomToken } from '../../utils/crypto';
import { buildRawGmailMessage } from '../../utils/gmail';
import { GmailSender } from '../queue/process-send';

const SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/gmail.send',
];

function oauthClient(config: AppConfig) {
  if (!config.googleClientId || !config.googleClientSecret || !config.googleRedirectUri) {
    throw new AppError(503, 'GMAIL_NOT_CONFIGURED', 'Google OAuth is not configured on the server');
  }
  return new google.auth.OAuth2(config.googleClientId, config.googleClientSecret, config.googleRedirectUri);
}

export async function beginGoogleAuth(db: OutreachDb, config: AppConfig): Promise<string> {
  const client = oauthClient(config);
  const state = randomToken(24);
  await db.oauthStates.create(state, new Date(Date.now() + 10 * 60 * 1000));
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
    state,
    include_granted_scopes: true,
  });
}

export async function completeGoogleAuth(db: OutreachDb, config: AppConfig, code: string, state: string): Promise<{ email: string }> {
  const valid = await db.oauthStates.consume(state, new Date());
  if (!valid) throw new AppError(400, 'OAUTH_STATE_INVALID', 'OAuth state is invalid or expired');
  const client = oauthClient(config);
  const tokenResult = await client.getToken(code);
  const tokens = tokenResult.tokens;
  if (!tokens.refresh_token) {
    throw new AppError(400, 'OAUTH_NO_REFRESH_TOKEN', 'Google did not return a refresh token. Disconnect the app in your Google account and try again.');
  }
  client.setCredentials(tokens);
  const oauth2 = google.oauth2({ version: 'v2', auth: client });
  const profile = await oauth2.userinfo.get();
  const email = profile.data.email;
  const googleAccountId = profile.data.id;
  if (!email || !googleAccountId) {
    throw new AppError(400, 'OAUTH_PROFILE_MISSING', 'Google did not return an account email');
  }
  const encryptedRefreshToken = encryptString(tokens.refresh_token, config.tokenEncryptionKey);
  await db.gmailAccounts.upsert({
    email,
    googleAccountId,
    encryptedRefreshToken,
    scopes: SCOPES.join(' '),
  });
  await db.audit.create({
    eventType: 'GMAIL_CONNECTED',
    entityType: 'gmail_account',
    entityId: googleAccountId,
    metadata: { email },
  });
  return { email };
}

export async function disconnectGmail(db: OutreachDb): Promise<void> {
  const active = await db.gmailAccounts.getActive();
  await db.gmailAccounts.deactivate();
  await db.audit.create({
    eventType: 'GMAIL_DISCONNECTED',
    entityType: 'gmail_account',
    entityId: active?.id ?? null,
    metadata: { email: active?.email ?? null },
  });
}

export async function getGmailAccountView(db: OutreachDb) {
  const account = await db.gmailAccounts.getActive();
  if (!account) return { connected: false as const };
  return {
    connected: true as const,
    email: account.email,
    connectedAt: account.connectedAt,
    scopes: account.scopes.split(' ').filter(Boolean),
  };
}

export function createGmailSender(db: OutreachDb, config: AppConfig): GmailSender {
  return {
    async send(input) {
      const account = await db.gmailAccounts.getActive();
      if (!account?.encryptedRefreshToken) {
        const error = new Error('Gmail account is not connected');
        (error as { status?: number }).status = 401;
        throw error;
      }
      const refreshToken = decryptString(account.encryptedRefreshToken, config.tokenEncryptionKey);
      const client = oauthClient(config);
      client.setCredentials({ refresh_token: refreshToken });
      const gmail = google.gmail({ version: 'v1', auth: client });
      const raw = buildRawGmailMessage({
        from: account.email,
        to: input.to,
        subject: input.subject,
        text: input.text,
        html: input.html,
        unsubscribeUrl: input.unsubscribeUrl,
      });
      const response = await gmail.users.messages.send({
        userId: 'me',
        requestBody: { raw },
      });
      return {
        id: response.data.id || '',
        threadId: response.data.threadId || null,
      };
    },
  };
}
