/**
 * Exploration script: probe WHOOP internal API for strength trainer endpoints.
 *
 * Usage: WHOOP_REFRESH_TOKEN=xxx pnpm tsx scripts/explore-whoop-strength.ts
 *
 * Get your refresh token from the provider_token table in the DB.
 */

const WHOOP_API_BASE = "https://api.prod.whoop.com";
const COGNITO_ENDPOINT = `${WHOOP_API_BASE}/auth-service/v3/whoop/`;
const COGNITO_CLIENT_ID = "37365lrcda1js3fapqfe2n40eh";

async function refreshToken(refreshToken: string): Promise<{ accessToken: string; userId: number }> {
  const response = await fetch(COGNITO_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-amz-json-1.1",
      "X-Amz-Target": "AWSCognitoIdentityProviderService.InitiateAuth",
    },
    body: JSON.stringify({
      AuthFlow: "REFRESH_TOKEN_AUTH",
      ClientId: COGNITO_CLIENT_ID,
      AuthParameters: { REFRESH_TOKEN: refreshToken },
    }),
  });

  const data = (await response.json()) as Record<string, unknown>;
  const authResult = data.AuthenticationResult as Record<string, unknown>;
  const accessToken = authResult.AccessToken as string;

  // Get user ID from bootstrap
  const bootstrapResp = await fetch(
    `${WHOOP_API_BASE}/users-service/v2/bootstrap/?accountType=users&apiVersion=7&include=profile`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  const bootstrapData = (await bootstrapResp.json()) as Record<string, unknown>;
  const user = bootstrapData.user as Record<string, unknown> | undefined;
  const userId = (bootstrapData.id ?? bootstrapData.user_id ?? user?.id ?? user?.user_id) as number;

  return { accessToken, userId };
}

async function main() {
  const rt = process.env.WHOOP_REFRESH_TOKEN;
  if (!rt) {
    console.error("Set WHOOP_REFRESH_TOKEN env var");
    process.exit(1);
  }

  console.log("Refreshing access token...");
  const { accessToken, userId } = await refreshToken(rt);
  console.log(`User ID: ${userId}`);

  // First, get a list of workout IDs (especially strength trainer ones)
  console.log("\n--- Fetching workouts to find strength trainer activity IDs ---");
  const cyclesResp = await fetch(
    `${WHOOP_API_BASE}/core-details-bff/v0/cycles/details?id=${userId}&startTime=2026-01-01T00:00:00Z&endTime=2026-04-01T00:00:00Z&limit=100&apiVersion=7`,
    { headers: { Authorization: `Bearer ${accessToken}`, "User-Agent": "WHOOP/4.0" } },
  );
  const cyclesData = await cyclesResp.json() as unknown[];
  const cycles = Array.isArray(cyclesData) ? cyclesData : [];
  const workoutIds: string[] = [];
  for (const cycle of cycles) {
    const c = cycle as Record<string, unknown>;
    const strain = c.strain as Record<string, unknown> | undefined;
    const workouts = strain?.workouts as Record<string, unknown>[] | undefined;
    if (workouts) {
      for (const w of workouts) {
        const sportId = w.sport_id as number;
        const activityId = w.activity_id as number | undefined;
        const id = w.id as number | undefined;
        console.log(`  Workout: sport_id=${sportId} activity_id=${activityId} id=${id}`);
        if (activityId) workoutIds.push(String(activityId));
        if (id) workoutIds.push(String(id));
      }
    }
  }
  console.log(`Found ${workoutIds.length} workout IDs`);

  // Use first workout ID for detail probes
  const sampleWorkoutId = workoutIds[0] ?? "0";

  const endpoints = [
    // Try without apiVersion param (mobile app may not send it for some services)
    { path: `/developer/v2/activity/strength-trainer`, noApiVersion: true },
    { path: `/developer/v2/activity/strength-trainer?limit=10`, noApiVersion: true },
    // Workout detail endpoints with a real workout ID
    { path: `/activities-service/v1/activities/${sampleWorkoutId}` },
    { path: `/activities-service/v1/activities/${sampleWorkoutId}/exercises` },
    { path: `/activities-service/v1/workout/${sampleWorkoutId}` },
    { path: `/activities-service/v1/workout/${sampleWorkoutId}/exercises` },
    { path: `/activities-service/v1/workout/${sampleWorkoutId}/details` },
    // Strength trainer with workout ID
    { path: `/strength-trainer/v1/workout/${sampleWorkoutId}` },
    { path: `/strength-trainer/v1/activity/${sampleWorkoutId}` },
    // MSK / muscular load
    { path: `/msk/v1/workout/${sampleWorkoutId}` },
    { path: `/msk-service/v1/workout/${sampleWorkoutId}` },
    // Fitness service with workout ID
    { path: `/fitness-service/v1/workout/${sampleWorkoutId}` },
    { path: `/fitness-service/v1/activity/${sampleWorkoutId}` },
    { path: `/fitness-service/v1/workout/${sampleWorkoutId}/exercises` },
    // User-scoped fitness
    { path: `/fitness-service/v1/users/${userId}/workouts` },
    { path: `/fitness-service/v1/users/${userId}/exercises` },
    // Training service
    { path: `/training-service/v1/workouts` },
    { path: `/training-service/v1/user/${userId}/workouts` },
    // Workout BFF
    { path: `/workout-bff/v1/workout/${sampleWorkoutId}` },
    { path: `/workout-details-bff/v1/workout/${sampleWorkoutId}` },
    // Coach / AI workout builder
    { path: `/coach-service/v1/workouts` },
    { path: `/coach-service/v1/user/${userId}/workouts` },
    // Try the activities endpoint that was CORS-blocked
    { path: `/activities-service/v1/activities?id=${userId}` },
    { path: `/activities-service/v1/activities?userId=${userId}` },
  ];

  for (const ep of endpoints) {
    const endpoint = typeof ep === "string" ? { path: ep } : ep;
    const apiVersionSuffix = endpoint.noApiVersion ? "" : `${endpoint.path.includes("?") ? "&" : "?"}apiVersion=7`;
    const url = `${WHOOP_API_BASE}${endpoint.path}${apiVersionSuffix}`;
    try {
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "User-Agent": "WHOOP/4.0",
        },
      });

      const text = await response.text();
      const status = response.status;
      const preview = text.slice(0, 800);

      if (status === 200) {
        console.log(`\n✅ ${status} ${endpoint.path}`);
        console.log(preview);
        if (text.length > 800) console.log(`... (${text.length} chars total)`);
      } else if (status === 404) {
        console.log(`❌ ${status} ${endpoint.path}`);
      } else {
        console.log(`⚠️  ${status} ${endpoint.path}: ${preview.slice(0, 200)}`);
      }
    } catch (err) {
      console.log(`💥 ${endpoint.path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  process.exit(0);
}

main();
