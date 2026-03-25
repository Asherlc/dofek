/**
 * Exploration script: probe WHOOP internal API for raw sensor/accelerometer data.
 *
 * Usage: WHOOP_REFRESH_TOKEN=xxx pnpm tsx scripts/explore-whoop-raw-sensor.ts
 *
 * Get your refresh token from the DB:
 *   SELECT refresh_token FROM fitness.oauth_token WHERE provider_id = 'whoop';
 *
 * Endpoints discovered via APK decompilation (WHOOP Android v5.439.0).
 *
 * Known upload endpoints (from decompiled SensorDataApi, DataSyncApi,
 * ResearchMetricsApi, PulseInformationMetricsApi):
 *   POST metrics-service/v1/metrics          — main sensor data (HR, accel, etc.)
 *   POST metrics-service/v1/metrics/sensor   — raw BLE data packets
 *   POST metrics-service/v1/research         — whoop labs research data
 *   POST research-metrics-service/v1/imu/upload    — IMU/accelerometer data
 *   POST research-metrics-service/v1/optical/upload — optical (PPG) sensor data
 *   POST research-metrics-service/v1/research/upload — research packets
 *   POST pip-metrics-service/v1/pip/upload   — pulse information packets
 *
 * This script probes for corresponding GET/download endpoints.
 */

const WHOOP_API_BASE = "https://api.prod.whoop.com";
const COGNITO_ENDPOINT = `${WHOOP_API_BASE}/auth-service/v3/whoop/`;
const COGNITO_CLIENT_ID = "37365lrcda1js3fapqfe2n40eh";

async function refreshAccessToken(rt: string) {
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
  const authResult: Record<string, unknown> = (data.AuthenticationResult ?? {}) satisfies Record<
    string,
    unknown
  >;
  const accessToken = String(authResult.AccessToken);

  const bootstrapResp = await fetch(
    `${WHOOP_API_BASE}/users-service/v2/bootstrap/?accountType=users&apiVersion=7&include=profile`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  const bootstrapData: Record<string, unknown> = await bootstrapResp.json();
  const user: Record<string, unknown> | undefined =
    bootstrapData.user && typeof bootstrapData.user === "object"
      ? (bootstrapData.user satisfies Record<string, unknown>)
      : undefined;
  const userId = Number(bootstrapData.id ?? bootstrapData.user_id ?? user?.id ?? user?.user_id);

  return { accessToken, userId };
}

interface Probe {
  path: string;
  method?: string;
  description: string;
  params?: Record<string, string>;
}

async function probe(accessToken: string, { path, method = "GET", description, params }: Probe) {
  const url = new URL(`${WHOOP_API_BASE}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  }

  try {
    const response = await fetch(url.toString(), {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": "WHOOP/4.0",
      },
    });

    const text = await response.text();
    const status = response.status;

    if (status === 200) {
      console.log(`\n✅ ${status} ${method} ${description}`);
      console.log(`   ${url.pathname}${url.search}`);
      // Try to pretty-print JSON
      try {
        const json = JSON.parse(text);
        console.log(JSON.stringify(json, null, 2).slice(0, 3000));
      } catch {
        console.log(text.slice(0, 3000));
      }
      if (text.length > 3000) console.log(`... (${text.length} chars total)`);
    } else if (status === 404) {
      console.log(`❌ ${status} ${method} ${description}`);
    } else {
      console.log(`⚠️  ${status} ${method} ${description}: ${text.slice(0, 300)}`);
    }
  } catch (err) {
    console.log(`💥 ${method} ${description}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function main() {
  const rt = process.env.WHOOP_REFRESH_TOKEN;
  if (!rt) {
    console.error("Set WHOOP_REFRESH_TOKEN env var");
    process.exit(1);
  }

  console.log("Refreshing access token...");
  const { accessToken, userId } = await refreshAccessToken(rt);
  console.log(`User ID: ${userId}\n`);

  // Time range: last 24 hours
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const start = yesterday.toISOString();
  const end = now.toISOString();

  // =====================================================================
  // 1. Metrics service — try different metric names
  //    We know name=heart_rate works. What else is available?
  // =====================================================================
  console.log("=== metrics-service/v1/metrics — different metric names ===\n");

  const metricNames = [
    "heart_rate",
    "accelerometer",
    "accel",
    "imu",
    "raw",
    "spo2",
    "skin_temp",
    "skin_temperature",
    "temperature",
    "hrv",
    "resting_heart_rate",
    "respiratory_rate",
    "blood_oxygen",
    "strain",
    "recovery",
    "calories",
    "steps",
    "activity",
    "movement",
    "motion",
  ];

  for (const name of metricNames) {
    await probe(accessToken, {
      path: `/metrics-service/v1/metrics/user/${userId}`,
      description: `metrics name=${name}`,
      params: { start, end, step: "6", name },
    });
  }

  // Also try without /user/{userId} — the MetricsV1Api from the APK hits
  // GET metrics-service/v1/metrics directly (used on-device, auth token implies user)
  console.log("\n=== metrics-service/v1/metrics (no /user/ path) ===\n");

  for (const name of ["heart_rate", "accelerometer", "imu", "raw"]) {
    await probe(accessToken, {
      path: "/metrics-service/v1/metrics",
      description: `metrics (no user) name=${name}`,
      params: { start, end, step: "6", name },
    });
  }

  // =====================================================================
  // 2. Research metrics service — try GET equivalents of upload endpoints
  // =====================================================================
  console.log("\n=== research-metrics-service — probing for downloads ===\n");

  const researchPaths = [
    "/research-metrics-service/v1/imu",
    "/research-metrics-service/v1/imu/download",
    `/research-metrics-service/v1/imu/user/${userId}`,
    "/research-metrics-service/v1/imu/upload",
    "/research-metrics-service/v1/optical",
    "/research-metrics-service/v1/optical/download",
    `/research-metrics-service/v1/optical/user/${userId}`,
    "/research-metrics-service/v1/research",
    "/research-metrics-service/v1/research/download",
    `/research-metrics-service/v1/research/user/${userId}`,
    "/research-metrics-service/v1",
  ];

  for (const path of researchPaths) {
    await probe(accessToken, {
      path,
      description: `research ${path}`,
      params: { start, end },
    });
  }

  // =====================================================================
  // 3. Pulse information packet service
  // =====================================================================
  console.log("\n=== pip-metrics-service — probing ===\n");

  const pipPaths = [
    "/pip-metrics-service/v1/pip",
    "/pip-metrics-service/v1/pip/download",
    `/pip-metrics-service/v1/pip/user/${userId}`,
    "/pip-metrics-service/v1",
  ];

  for (const path of pipPaths) {
    await probe(accessToken, {
      path,
      description: `pip ${path}`,
      params: { start, end },
    });
  }

  // =====================================================================
  // 4. Data sync / consumer stats — high watermark and raw data
  // =====================================================================
  console.log("\n=== metrics-service consumer stats & sensor ===\n");

  await probe(accessToken, {
    path: "/metrics-service/v1/consumerstats/mobile/highwatermark/min",
    description: "high watermark (sync tracking)",
  });

  await probe(accessToken, {
    path: "/metrics-service/v1/metrics/sensor",
    description: "sensor metrics (GET on upload endpoint)",
    params: { start, end },
  });

  await probe(accessToken, {
    path: "/metrics-service/v1/consumerstats",
    description: "consumer stats root",
  });

  await probe(accessToken, {
    path: `/metrics-service/v1/consumerstats/user/${userId}`,
    description: "consumer stats for user",
  });

  // =====================================================================
  // 5. Member data export (GDPR export — may include raw sensor data)
  // =====================================================================
  console.log("\n=== member-data-export-service ===\n");

  await probe(accessToken, {
    path: "/member-data-export-service/v1/member-data-export-details",
    description: "data export details (what's available)",
  });

  await probe(accessToken, {
    path: "/member-data-export-service/v1/member-data-export",
    description: "data export root",
  });

  // =====================================================================
  // 6. Misc service probes — looking for raw data endpoints
  // =====================================================================
  console.log("\n=== misc service probes ===\n");

  const miscPaths = [
    "/sensor-data-service/v1/data",
    `/sensor-data-service/v1/data/user/${userId}`,
    "/sensor-data-service/v1/accelerometer",
    "/raw-data-service/v1/data",
    `/raw-data-service/v1/data/user/${userId}`,
    "/data-service/v1/raw",
    "/data-service/v1/sensor",
    `/data-service/v1/user/${userId}/raw`,
    "/metrics-service/v1/raw",
    `/metrics-service/v1/raw/user/${userId}`,
    "/metrics-service/v1/sensor-data",
    "/metrics-service/v1/imu",
    `/metrics-service/v1/imu/user/${userId}`,
    "/metrics-service/v1/accelerometer",
    `/metrics-service/v1/accelerometer/user/${userId}`,
    "/metrics-service/v2/metrics",
    `/metrics-service/v2/metrics/user/${userId}`,
  ];

  for (const path of miscPaths) {
    await probe(accessToken, {
      path,
      description: path,
      params: { start, end },
    });
  }

  console.log("\nDone!");
  process.exit(0);
}

main();
