import { and, desc, eq } from 'drizzle-orm'
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server'
import type {
  AuthenticatorTransportFuture,
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server'

import { db } from '#/db'
import { passkeys, session, user, verification } from '#/db/schema'
import { auth, webauthnConfig } from '#/lib/auth'
import { ulid } from '#/lib/ulid'

const CHALLENGE_TTL_MS = 5 * 60 * 1000

export interface PasskeyItem {
  id: string
  name: string
  createdAt: string
  lastUsedAt: string | null
  transports: string | null
}

export interface PasskeyRegistrationOptions {
  challengeId: string
  options: PublicKeyCredentialCreationOptionsJSON
}

export interface PasskeyLoginOptions {
  challengeId: string
  options: PublicKeyCredentialRequestOptionsJSON
}

async function storeChallenge(
  identifier: string,
  challenge: string,
): Promise<void> {
  await db.insert(verification).values({
    id: ulid(),
    identifier,
    value: challenge,
    expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
    createdAt: new Date(),
    updatedAt: new Date(),
  })
}

async function takeChallenge(identifier: string): Promise<string | null> {
  const authCtx = await auth.$context
  const row = await authCtx.internalAdapter.consumeVerificationValue(identifier)
  return row?.value ?? null
}

function parseTransports(raw: string | null): AuthenticatorTransportFuture[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed)
      ? (parsed as AuthenticatorTransportFuture[])
      : []
  } catch {
    return []
  }
}

export async function generatePasskeyRegistrationOptions(
  userId: string,
  userName: string,
  displayName: string,
): Promise<PasskeyRegistrationOptions> {
  const existing = await listPasskeysForUser(userId)
  const options = await generateRegistrationOptions({
    rpName: webauthnConfig.rpName,
    rpID: webauthnConfig.rpID,
    userName,
    userID: new TextEncoder().encode(userId),
    userDisplayName: displayName,
    attestationType: 'none',
    authenticatorSelection: {
      residentKey: 'required',
      userVerification: 'preferred',
    },
    excludeCredentials: existing.map((p) => ({
      id: p.id,
      transports: parseTransports(p.transports),
    })),
  })
  const challengeId = ulid()
  await storeChallenge(
    `passkey-register:${userId}:${challengeId}`,
    options.challenge,
  )
  return { challengeId, options }
}

export async function verifyPasskeyRegistration(
  userId: string,
  name: string,
  challengeId: string,
  response: RegistrationResponseJSON,
): Promise<PasskeyItem[]> {
  const identifier = `passkey-register:${userId}:${challengeId}`
  const expectedChallenge = await takeChallenge(identifier)
  if (!expectedChallenge) throw new Error('challenge expired, 请重试')

  const verificationResult = await verifyRegistrationResponse({
    response,
    expectedChallenge,
    expectedOrigin: webauthnConfig.origin,
    expectedRPID: webauthnConfig.rpID,
  })
  if (!verificationResult.verified) {
    throw new Error('passkey 校验失败')
  }
  const { credential } = verificationResult.registrationInfo
  await db.insert(passkeys).values({
    id: credential.id,
    userId,
    name: name.trim() || 'Passkey',
    publicKey: Buffer.from(credential.publicKey).toString('base64url'),
    counter: credential.counter,
    transports: JSON.stringify(
      (response as { response?: { transports?: string[] } }).response
        ?.transports ?? [],
    ),
    createdAt: new Date(),
  })
  return listPasskeysForUser(userId)
}

export async function generatePasskeyLoginOptions(): Promise<PasskeyLoginOptions> {
  const options = await generateAuthenticationOptions({
    rpID: webauthnConfig.rpID,
    userVerification: 'preferred',
    // 不限定凭据：由系统选择已注册的 discoverable credential
    allowCredentials: [],
  })
  const challengeId = ulid()
  await storeChallenge(`passkey-login:${challengeId}`, options.challenge)
  return { challengeId, options }
}

/** 校验断言后创建会话，返回 one-time token 供客户端换取会话 cookie */
export async function verifyPasskeyLogin(
  challengeId: string,
  response: AuthenticationResponseJSON,
): Promise<{ token: string; user: { id: string; name: string } }> {
  const expectedChallenge = await takeChallenge(`passkey-login:${challengeId}`)
  if (!expectedChallenge) throw new Error('challenge expired, 请重试')

  const passkey = await db.query.passkeys.findFirst({
    where: eq(passkeys.id, response.id),
  })
  if (!passkey) throw new Error('passkey not found')
  if (
    response.response.userHandle &&
    response.response.userHandle !==
      Buffer.from(passkey.userId).toString('base64url')
  ) {
    throw new Error('passkey mismatch')
  }

  const result = await verifyAuthenticationResponse({
    response,
    expectedChallenge,
    expectedOrigin: webauthnConfig.origin,
    expectedRPID: webauthnConfig.rpID,
    credential: {
      id: passkey.id,
      publicKey: Buffer.from(passkey.publicKey, 'base64url'),
      counter: passkey.counter,
      transports: parseTransports(passkey.transports),
    },
  })
  if (!result.verified) throw new Error('passkey 校验失败')

  const authCtx = await auth.$context
  const tokenBytes = new Uint8Array(32)
  crypto.getRandomValues(tokenBytes)
  const token = Buffer.from(tokenBytes).toString('base64url')
  const sessionTokenBytes = new Uint8Array(32)
  crypto.getRandomValues(sessionTokenBytes)
  const sessionToken = Buffer.from(sessionTokenBytes).toString('base64url')
  const now = new Date()

  await db.transaction(async (tx) => {
    const updated = await tx
      .update(passkeys)
      .set({
        counter: result.authenticationInfo.newCounter,
        lastUsedAt: now,
      })
      .where(
        and(eq(passkeys.id, passkey.id), eq(passkeys.counter, passkey.counter)),
      )
      .returning({ id: passkeys.id })
    if (updated.length !== 1) throw new Error('passkey 已被使用，请重试')

    await tx.insert(session).values({
      id: ulid(),
      token: sessionToken,
      userId: passkey.userId,
      expiresAt: new Date(
        now.getTime() + authCtx.sessionConfig.expiresIn * 1000,
      ),
      createdAt: now,
      updatedAt: now,
    })
    await tx.insert(verification).values({
      id: ulid(),
      value: sessionToken,
      identifier: `one-time-token:${token}`,
      expiresAt: new Date(now.getTime() + 3 * 60 * 1000),
      createdAt: now,
      updatedAt: now,
    })
  })
  const userRow = await db.query.user.findFirst({
    where: eq(user.id, passkey.userId),
    columns: { id: true, name: true },
  })
  return {
    token,
    user: { id: passkey.userId, name: userRow?.name ?? '' },
  }
}

export async function listPasskeysForUser(
  userId: string,
): Promise<PasskeyItem[]> {
  const rows = await db
    .select({
      id: passkeys.id,
      name: passkeys.name,
      createdAt: passkeys.createdAt,
      lastUsedAt: passkeys.lastUsedAt,
      transports: passkeys.transports,
    })
    .from(passkeys)
    .where(eq(passkeys.userId, userId))
    .orderBy(desc(passkeys.createdAt))
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    createdAt: r.createdAt.toISOString(),
    lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
    transports: r.transports,
  }))
}

export async function deletePasskeyForUser(
  userId: string,
  credentialId: string,
): Promise<{ deleted: boolean }> {
  const res = await db
    .delete(passkeys)
    .where(and(eq(passkeys.id, credentialId), eq(passkeys.userId, userId)))
    .returning({ id: passkeys.id })
  return { deleted: res.length > 0 }
}
