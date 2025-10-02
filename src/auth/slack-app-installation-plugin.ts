import { generateId } from 'better-auth'
import { createAuthEndpoint, getSessionFromCtx, APIError } from 'better-auth/api'
import type { BetterAuthPlugin } from 'better-auth/plugins'
import type { Installation, OAuthV2Response } from '@slack/oauth'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { WebClient } from '@slack/web-api'
import { generateState, createAuthorizationURL, parseState } from 'better-auth/oauth2'
import { symmetricEncrypt } from 'better-auth/crypto'
import db from '../db/engine'
import { organizationTable, memberTable, slackAppInstallationTable } from '../db/schema/auth'
import { getSlackClient } from '../integrations/slack'

export const SLACK_APP_SCOPES = [
  'channels:history',
  'channels:join',
  'channels:read',
  'chat:write',
  'im:history',
  'im:read',
  'im:write',
  'mpim:read',
  'mpim:write',
  'reactions:read',
  'reactions:write',
  'users:read',
  'users:read.email',
  'mpim:history',
  'channels:manage',
  'canvases:read',
  'groups:history',
  'groups:read',
  'groups:write',
  'links:read',
  'emoji:read',
  'files:read',
  'pins:read',
  'search:read.users',
  'team:read',
  'usergroups:read',
  'users.profile:read',
]

export function slackAppInstallationPlugin() {
  return {
    id: 'slack-app-installation-plugin',

    endpoints: {
      // Initiate Slack app OAuth flow
      authorize: createAuthEndpoint('/slack-app/init-install', {
        method: 'POST',
        body: z.strictObject({
          'callbackURL': z.string(),
        }),
      },async (c) => {
        const session = await getSessionFromCtx(c)
        if (!session?.user) {
          c.context.logger.error('No logged in user found')
          throw new APIError('UNAUTHORIZED', {
            message: 'No logged in user found',
          })
        }

        const { state, codeVerifier } = await generateState(c, {
          userId: session.user.id,
          email: session.user.email,
        })

        const installUrl = await createAuthorizationURL({
          id: '', // unused
          options: {
            clientId: process.env.PV_SLACK_CLIENT_ID,
            clientSecret: process.env.PV_SLACK_CLIENT_SECRET,
          },
          redirectURI: `${c.context.baseURL}/slack-app/callback`,
          authorizationEndpoint: 'https://slack.com/oauth/v2/authorize',
          state,
          codeVerifier,
          scopes: SLACK_APP_SCOPES,
        })

        return c.json({ installUrl: installUrl.toString() })
      }),

      // Handle Slack OAuth callback
      callback: createAuthEndpoint('/slack-app/callback', {
        method: 'GET',
      }, async (c) => {
        const code = c.query?.code as string | undefined
        const state = c.query?.state as string | undefined

        if (!code || !state) {
          c.context.logger.error('Missing code or state in callback')
          throw new APIError('BAD_REQUEST', {
            message: 'Missing code or state',
          })
        }

        const {
          codeVerifier,
          callbackURL,
          link,
        } = await parseState(c)

        // Verify current user session
        const session = await getSessionFromCtx(c)
        if (!session?.user) {
          c.context.logger.error('No user session found')
          throw new APIError('UNAUTHORIZED', {
            message: 'No user session found',
          })
        }

        // Check that link matches current user
        if (link?.userId !== session.user.id || link?.email !== session.user.email) {
          c.context.logger.error('Link userId and email does not match current user')
          throw new APIError('FORBIDDEN', {
            message: 'User mismatch',
          })
        }

        // Exchange code for tokens
        const tokenResponse = await fetch('https://slack.com/api/oauth.v2.access', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: process.env.PV_SLACK_CLIENT_ID!,
            client_secret: process.env.PV_SLACK_CLIENT_SECRET!,
            code,
            code_verifier: codeVerifier,
            redirect_uri: `${c.context.baseURL}/slack-app/callback`,
          }),
        })

        const res = await tokenResponse.json() as OAuthV2Response

        if (!res.ok || !res.access_token || !res.team?.id) {
          c.context.logger.error('Failed to exchange code for token', res.error)
          throw new APIError('INTERNAL_SERVER_ERROR', {
            message: 'Failed to exchange code for token',
          })
        }

        // Get user's organization and verify team ID matches
        const [userOrg] = await db.select({ slackTeamId: organizationTable.slackTeamId })
          .from(memberTable)
          .innerJoin(organizationTable, eq(memberTable.organizationId, organizationTable.id))
          .where(eq(memberTable.userId, session.user.id))
          .limit(1)

        if (userOrg?.slackTeamId !== res.team.id) {
          c.context.logger.error('Team ID does not match user organization')
          throw new APIError('FORBIDDEN', {
            message: 'Team ID mismatch',
          })
        }

        // Need to hit auth.test to get bot id
        const client = new WebClient(res.access_token)
        const authTestInfo = await client.auth.test()

        if (!res.bot_user_id || !authTestInfo.bot_id) {
          c.context.logger.error('Bot user not found')
          throw new APIError('NOT_FOUND', {
            message: 'Bot user not found',
          })
        }

        if (res.authed_user.access_token) {
          c.context.logger.error('User auth is not supported')
          throw new APIError('FORBIDDEN', {
            message: 'User auth is not supported',
          })
        }

        if (res.is_enterprise_install) {
          c.context.logger.error('Enterprise install is not supported')
          throw new APIError('FORBIDDEN', {
            message: 'Enterprise install is not supported',
          })
        }

        if (res.incoming_webhook) {
          c.context.logger.error('Incoming webhook is not supported')
          throw new APIError('FORBIDDEN', {
            message: 'Incoming webhook is not supported',
          })
        }

        // Parse the slack api response into a node-slack-sdk Installation object
        // See https://github.com/slackapi/node-slack-sdk/blob/main/packages/oauth/src/install-provider.ts
        const installation: Installation<'v2', boolean> = {
          authVersion: 'v2',
          team: res.team,
          enterprise: res.enterprise == null ? undefined : res.enterprise,
          user: {
            token: undefined,
            scopes: undefined,
            id: res.authed_user.id,
          },
          bot: {
            scopes: res.scope?.split(',') || [],
            token: await symmetricEncrypt({
              key: c.context.secret,
              data: res.access_token,
            }),
            userId: res.bot_user_id,
            id: authTestInfo.bot_id,
          },
          tokenType: res.token_type,
          isEnterpriseInstall: res.is_enterprise_install,
          enterpriseUrl: res.is_enterprise_install ? authTestInfo.url : undefined,
          appId: res.app_id,
        }

        // Handle token rotation if it is enabled
        if (res.refresh_token !== undefined && res.expires_in !== undefined && installation.bot) {
          const currentUTC = Math.floor(Date.now() / 1000) // utc, seconds
          installation.bot.refreshToken = res.refresh_token
          installation.bot.expiresAt = currentUTC + res.expires_in
        }

        // Store bot token in slackAppInstallation table
        await db.insert(slackAppInstallationTable)
          .values({
            id: generateId(),
            teamId: res.team.id,
            installation,
            createdByUserId: session.user.id,
          })
          .onConflictDoUpdate({
            target: slackAppInstallationTable.teamId,
            set: {
              installation,
              createdByUserId: session.user.id,
              createdAt: new Date(),
            },
          })

        c.context.logger.info(`Slack app installed for team ${res.team.id}`)

        return c.redirect(callbackURL)
      }),

      // Uninstall Slack app
      uninstall: createAuthEndpoint('/slack-app/uninstall', {
        method: 'POST',
      }, async (c) => {
        const session = await getSessionFromCtx(c)
        if (!session?.user) {
          c.context.logger.error('No logged in user found')
          throw new APIError('UNAUTHORIZED', {
            message: 'No logged in user found',
          })
        }

        // Get the Slack client for this user
        const client = await getSlackClient(session.user.id)
        if (!client) {
          c.context.logger.error('No Slack app installation found for user')
          throw new APIError('NOT_FOUND', {
            message: 'No Slack app installation found',
          })
        }

        // Call apps.uninstall
        try {
          await client.apps.uninstall({
            client_id: process.env.PV_SLACK_CLIENT_ID!,
            client_secret: process.env.PV_SLACK_CLIENT_SECRET!,
          })
        } catch (error) {
          c.context.logger.error('Failed to uninstall Slack app', error)
          throw new APIError('INTERNAL_SERVER_ERROR', {
            message: 'Failed to uninstall Slack app',
          })
        }

        // Delete the slackAppInstallation record
        const [result] = await db.select({ teamId: organizationTable.slackTeamId })
          .from(memberTable)
          .innerJoin(organizationTable, eq(memberTable.organizationId, organizationTable.id))
          .where(eq(memberTable.userId, session.user.id))
          .limit(1)

        if (result?.teamId) {
          await db.delete(slackAppInstallationTable)
            .where(eq(slackAppInstallationTable.teamId, result.teamId))
        }

        c.context.logger.info('Slack app uninstalled successfully')

        return c.json({ success: true })
      }),
    },

    schema: {
      slackAppInstallation: {
        fields: {
          teamId: {
            type: 'string',
            required: true,
            unique: true,
            references: {
              model: 'organization',
              field: 'slackTeamId',
              onDelete: 'cascade',
            },
          },
          installation: {
            type: 'json',
            required: true,
          },
          createdByUserId: {
            type: 'string',
            required: true,
            references: {
              model: 'user',
              field: 'id',
              onDelete: 'cascade',
            },
          },
          createdAt: {
            type: 'date',
            required: true,
          },
        },
      },
    },
  } satisfies BetterAuthPlugin
}
