import { createAuthEndpoint, createAuthMiddleware, getSessionFromCtx, APIError } from 'better-auth/api'
import { generateId } from 'better-auth'
import type { BetterAuthPlugin } from 'better-auth/plugins'
import { createRandomStringGenerator } from '@better-auth/utils/random'
import { eq, and } from 'drizzle-orm'
import db from '../db/engine'
import { memberTable, organizationTable, githubAppInstallationTable, accountTable } from '../db/schema/auth'

const generateRandomString = createRandomStringGenerator('a-z', '0-9', 'A-Z', '-_')

export function githubAppInstallationPlugin(appName: string) {
  return {
    id: 'github-app-installation-plugin',
    endpoints: {
      // Store verification data to imitate the default github better-auth flow, and
      // generate the github app installation url
      initiateInstallation: createAuthEndpoint('/github-app/init-install', {
        method: 'POST',
      }, async (c) => {
        const session = await getSessionFromCtx(c)
        if (!session?.user) {
          c.context.logger.error('No logged in user found')
          throw new APIError('UNAUTHORIZED', {
            message: 'No logged in user found',
          })
        }

        const state = generateRandomString(32)
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000)

        // For data format, see https://github.com/better-auth/better-auth/blob/main/packages/better-auth/src/oauth2/state.ts
        // TODO: add errorURL
        const data = JSON.stringify({
          callbackURL: `${c.context.options.baseURL}/profile`,
          codeVerifier: '', // Required by github callback, but ignored if empty string
          link: {
            email: session.user.email,
            userId: session.user.id,
          },
          expiresAt: expiresAt.getTime(),
        })

        const verification = await c.context.internalAdapter.createVerificationValue(
          {
            value: data,
            identifier: state,
            expiresAt,
          },
          c,
        )
        if (!verification) {
          c.context.logger.error('Unable to create verification')
          throw new APIError('INTERNAL_SERVER_ERROR', {
            message: 'Unable to create verification',
          })
        }

        // Construct Github App installation URL
        const installUrl = new URL(`https://github.com/apps/${appName}/installations/new`)
        installUrl.searchParams.set('state', state)

        return c.json({ installUrl: installUrl.toString() })
      }),
    },

    // Save installation id to the user after the standard oauth callback
    hooks: {
      after: [{
        matcher: (c) => {
          return c.path === '/callback/:id' && c.params?.id === 'github'
        },
        handler: createAuthMiddleware(async (c) => {
          const installationId = c.query?.installation_id as string | undefined
          if (!installationId) {
            c.context.logger.error('No installation_id found after Github callback')
            return
          }

          const session = await getSessionFromCtx(c)
          if (!session?.user) {
            c.context.logger.error('No user session found after Github callback')
            return
          }

          // Get the user's organization with a single join
          const [userOrg] = await db.select({ slackTeamId: organizationTable.slackTeamId })
            .from(memberTable)
            .innerJoin(organizationTable, eq(memberTable.organizationId, organizationTable.id))
            .where(eq(memberTable.userId, session.user.id))
            .limit(1)

          if (!userOrg) {
            c.context.logger.error('No organization membership found for user')
            return
          }

          // Insert the GitHub app installation
          await db.insert(githubAppInstallationTable)
            .values({
              id: generateId(),
              slackTeamId: userOrg.slackTeamId,
              installationId,
              createdByUserId: session.user.id,
            })

          // Remove the user's Github account, which is no longer needed
          await db.delete(accountTable)
            .where(and(
              eq(accountTable.providerId, 'github'),
              eq(accountTable.userId, session.user.id),
            ))

          c.context.logger.info('Github installation ID saved successfully')
        }),
      }],
    },

    schema: {
      githubAppInstallation: {
        fields: {
          slackTeamId: {
            type: 'string',
            required: true,
            unique: true,
            references: {
              model: 'organization',
              field: 'slackTeamId',
              onDelete: 'cascade',
            },
          },
          installationId: {
            type: 'string',
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
          repositoryId: {
            type: 'string',
          },
          repositoryConnectedByUserId: {
            type: 'string',
            references: {
              model: 'user',
              field: 'id',
              onDelete: 'set null',
            },
          },
          repositoryConnectedAt: {
            type: 'date',
          },
        },
      },
    },
  } satisfies BetterAuthPlugin
}

