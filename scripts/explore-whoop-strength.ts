/**
 * Exploration script: probe WHOOP internal API for strength trainer endpoints.
 *
 * Usage: WHOOP_REFRESH_TOKEN=xxx pnpm tsx scripts/explore-whoop-strength.ts
 *
 * Get your refresh token from the DB:
 *   SELECT refresh_token FROM fitness.oauth_token WHERE provider_id = 'whoop';
 *
 * Endpoints discovered via APK decompilation (WHOOP Android v5.439.0).
 */

const WHOOP_API_BASE = "https://api.prod.whoop.com";
const COGNITO_ENDPOINT = `${WHOOP_API_BASE}/auth-service/v3/whoop/`;
const COGNITO_CLIENT_ID = "37365lrcda1js3fapqfe2n40eh";

interface AuthResult {
  accessToken: string;
  userId: number;
}

async function refreshAccessToken(rt: string): Promise<AuthResult> {
  const response = await fetch(COGNITO_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-amz-json-1.1",
      "X-Amz-Target": "AWSCognitoIdentityProviderService.InitiateAuth",
    },
    body: JSON.stringify({
      AuthFlow: "REFRESH_TOKEN_AUTH",
      ClientId: COGNITO_CLIENT_ID,
      AuthParameters: { REFRESH_TOKEN: rt },
    }),
  });

  const data: Record<string, unknown> = await response.json();
  // @ts-expect-error — untyped API response, AuthenticationResult is a nested object
  const authResult: Record<string, unknown> = data.AuthenticationResult;
  const accessToken = String(authResult.AccessToken);

  // Get user ID from bootstrap
  const bootstrapResp = await fetch(
    `${WHOOP_API_BASE}/users-service/v2/bootstrap/?accountType=users&apiVersion=7&include=profile`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  const bootstrapData: Record<string, unknown> = await bootstrapResp.json();
  // @ts-expect-error — untyped API response, user is a nested object
  const user: Record<string, unknown> | undefined = bootstrapData.user;
  const userId = Number(bootstrapData.id ?? bootstrapData.user_id ?? user?.id ?? user?.user_id);

  return { accessToken, userId };
}

interface EndpointConfig {
  path: string;
  noApiVersion?: boolean;
  method?: string;
  description?: string;
}

async function main() {
  const rt = process.env.WHOOP_REFRESH_TOKEN;
  if (!rt) {
    console.error("Set WHOOP_REFRESH_TOKEN env var");
    process.exit(1);
  }

  console.log("Refreshing access token...");
  const { accessToken, userId } = await refreshAccessToken(rt);
  console.log(`User ID: ${userId}`);

  // First, get a list of workout activity IDs
  console.log("\n--- Fetching workouts to find activity IDs ---");
  const cyclesResp = await fetch(
    `${WHOOP_API_BASE}/core-details-bff/v0/cycles/details?id=${userId}&startTime=2026-01-01T00:00:00Z&endTime=2026-04-01T00:00:00Z&limit=100&apiVersion=7`,
    { headers: { Authorization: `Bearer ${accessToken}`, "User-Agent": "WHOOP/4.0" } },
  );
  const cyclesRaw = await cyclesResp.text();

  let cyclesData: unknown;
  try {
    cyclesData = JSON.parse(cyclesRaw);
  } catch {
    cyclesData = null;
  }

  // Extract workout IDs from cycles response
  const workouts: Array<{ activityId: string; sportId: number }> = [];
  function extractWorkouts(obj: unknown, depth = 0): void {
    if (depth > 5 || !obj || typeof obj !== "object") return;
    if (Array.isArray(obj)) {
      for (const item of obj) extractWorkouts(item, depth + 1);
      return;
    }
    // @ts-expect-error — obj is narrowed to non-null, non-array object
    const rec: Record<string, unknown> = obj;
    if ("sport_id" in rec) {
      const sportId = Number(rec.sport_id);
      const activityId = String(rec.activity_id ?? rec.id ?? "");
      console.log(`  Workout: sport_id=${sportId} activity_id=${activityId}`);
      if (activityId) workouts.push({ activityId, sportId });
    }
    for (const val of Object.values(rec)) {
      if (val && typeof val === "object") extractWorkouts(val, depth + 1);
    }
  }
  extractWorkouts(cyclesData);
  console.log(`Found ${workouts.length} workouts`);

  // Use first workout for probes
  const sampleActivityId = workouts[0]?.activityId ?? "0";
  console.log(`Using sample activity ID: ${sampleActivityId}`);

  // =====================================================================
  // Endpoints from APK decompilation (WHOOP Android v5.439.0)
  // =====================================================================
  const endpoints: EndpointConfig[] = [
    // --- weightlifting-service (discovered from DEX strings) ---
    { path: `/weightlifting-service/v1/exercise`, description: "Exercise catalog v1" },
    { path: `/weightlifting-service/v2/exercise`, description: "Exercise catalog v2" },
    { path: `/weightlifting-service/v2/custom-exercise`, description: "Custom exercises" },
    {
      path: `/weightlifting-service/v2/weightlifting-workout/activity`,
      description: "Workout by activity (likely needs query param)",
    },
    {
      path: `/weightlifting-service/v2/weightlifting-workout/activity?activityId=${sampleActivityId}`,
      description: "Workout by activity ID param",
    },
    {
      path: `/weightlifting-service/v2/weightlifting-workout/activity/${sampleActivityId}`,
      description: "Workout by activity ID path",
    },
    { path: `/weightlifting-service/v1/link-workout`, description: "Link workout" },
    {
      path: `/weightlifting-service/v2/weightlifting-workout/link-cardio-workout`,
      description: "Link cardio workout",
    },
    { path: `/weightlifting-service/v2/performance-profile`, description: "Performance profile" },
    {
      path: `/weightlifting-service/v2/performance-profile/template`,
      description: "Performance profile template",
    },
    { path: `/weightlifting-service/v2/workout-library`, description: "Workout library v2" },
    { path: `/weightlifting-service/v3/workout-library`, description: "Workout library v3" },
    { path: `/weightlifting-service/v3/workout-template`, description: "Workout template v3" },
    {
      path: `/weightlifting-service/v1/raw-data/protobuf`,
      description: "Raw sensor data (protobuf)",
    },
    { path: `/weightlifting-service/v3/prs`, description: "Personal records" },
    { path: `/weightlifting-service/v1/share/test`, description: "Share workout (placeholder ID)" },
    // Try without apiVersion (mobile app might not send it for this service)
    {
      path: `/weightlifting-service/v1/exercise`,
      noApiVersion: true,
      description: "Exercise catalog v1 (no apiVersion)",
    },
    {
      path: `/weightlifting-service/v2/exercise`,
      noApiVersion: true,
      description: "Exercise catalog v2 (no apiVersion)",
    },
    {
      path: `/weightlifting-service/v2/weightlifting-workout/activity`,
      noApiVersion: true,
      description: "Workout by activity (no apiVersion)",
    },

    // --- Also try each workout's activity ID against the workout endpoint ---
    ...workouts.map((w) => ({
      path: `/weightlifting-service/v2/weightlifting-workout/activity?activityId=${w.activityId}`,
      description: `Workout for activity ${w.activityId} (sport_id=${w.sportId})`,
    })),

    // --- Developer API strength trainer (CORS-blocked from browser) ---
    {
      path: `/developer/v2/activity/strength-trainer`,
      noApiVersion: true,
      description: "Developer API strength trainer",
    },
    {
      path: `/developer/v2/activity/strength-trainer?limit=10`,
      noApiVersion: true,
      description: "Developer API strength trainer with limit",
    },
  ];

  console.log(`\n--- Probing ${endpoints.length} endpoints ---\n`);

  for (const ep of endpoints) {
    const apiVersionSuffix = ep.noApiVersion
      ? ""
      : `${ep.path.includes("?") ? "&" : "?"}apiVersion=7`;
    const url = `${WHOOP_API_BASE}${ep.path}${apiVersionSuffix}`;
    try {
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "User-Agent": "WHOOP/4.0",
        },
      });

      const text = await response.text();
      const status = response.status;
      const preview = text.slice(0, 1500);

      if (status === 200) {
        console.log(`\n✅ ${status} ${ep.description ?? ep.path}`);
        console.log(`   URL: ${ep.path}`);
        console.log(preview);
        if (text.length > 1500) console.log(`... (${text.length} chars total)`);
      } else if (status === 404) {
        console.log(`❌ ${status} ${ep.description ?? ep.path}`);
      } else {
        console.log(`⚠️  ${status} ${ep.description ?? ep.path}: ${preview.slice(0, 300)}`);
      }
    } catch (err) {
      console.log(
        `💥 ${ep.description ?? ep.path}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  process.exit(0);
}

main();
