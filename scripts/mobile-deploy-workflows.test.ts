import { readFileSync } from "node:fs";
import { data, Evaluator, Lexer, Parser } from "@actions/expressions";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";

const workflowSchema = z.object({
  jobs: z.object({
    check: z.object({
      env: z
        .object({
          IOS_NATIVE_INPUT_PATTERN: z.string(),
        })
        .optional(),
    }),
    deploy: z.object({
      if: z.string(),
    }),
  }),
});

const alwaysFunction = {
  name: "always",
  minArgs: 0,
  maxArgs: 0,
  call: () => new data.BooleanData(true),
};

function readDeployCondition(workflowPath: string): string {
  const workflow = workflowSchema.parse(parse(readFileSync(workflowPath, "utf8")));
  return workflow.jobs.deploy.if;
}

function readIosNativeInputPattern(): RegExp {
  const workflow = workflowSchema.parse(
    parse(readFileSync(".github/workflows/deploy-ios.yml", "utf8")),
  );
  return new RegExp(z.string().parse(workflow.jobs.check.env?.IOS_NATIVE_INPUT_PATTERN));
}

function evaluateDeployCondition(
  condition: string,
  eventName: string,
  checkResult: string,
  shouldDeploy: string,
): boolean {
  const lexerResult = new Lexer(condition).lex();
  const expression = new Parser(lexerResult.tokens, ["github", "needs"], [alwaysFunction]).parse();
  const context = new data.Dictionary(
    {
      key: "github",
      value: new data.Dictionary({
        key: "event_name",
        value: new data.StringData(eventName),
      }),
    },
    {
      key: "needs",
      value: new data.Dictionary({
        key: "check",
        value: new data.Dictionary(
          {
            key: "result",
            value: new data.StringData(checkResult),
          },
          {
            key: "outputs",
            value: new data.Dictionary({
              key: "should_deploy",
              value: new data.StringData(shouldDeploy),
            }),
          },
        ),
      }),
    },
  );
  const functions = new Map([["always", alwaysFunction]]);
  return new Evaluator(expression, context, functions).evaluate().coerceString() === "true";
}

const eventNames = ["workflow_call", "workflow_dispatch", "workflow_run"];
const checkResults = ["success", "failure", "cancelled"];

describe("mobile deploy workflow conditions", () => {
  const otaCondition = readDeployCondition(".github/workflows/deploy-ota.yml");
  const iosCondition = readDeployCondition(".github/workflows/deploy-ios.yml");

  for (const eventName of eventNames) {
    for (const checkResult of checkResults) {
      it(`gates OTA for ${eventName} after a ${checkResult} check`, () => {
        expect(evaluateDeployCondition(otaCondition, eventName, checkResult, "true")).toBe(
          checkResult === "success",
        );
      });

      for (const shouldDeploy of ["true", "false"]) {
        it(`gates iOS for ${eventName} after a ${checkResult} check with should_deploy=${shouldDeploy}`, () => {
          expect(evaluateDeployCondition(iosCondition, eventName, checkResult, shouldDeploy)).toBe(
            checkResult === "success" && shouldDeploy === "true",
          );
        });
      }
    }
  }
});

describe("iOS native input detection", () => {
  const nativeInputPattern = readIosNativeInputPattern();

  const cases = [
    ["pnpm-lock.yaml", true],
    ["packages/mobile/package.json", true],
    ["packages/mobile/app.json", true],
    ["packages/mobile/app.config.js", true],
    ["packages/mobile/plugins/with-podfile-post-install.js", true],
    ["packages/mobile/build/ExportOptions.plist", true],
    ["packages/mobile/targets/DofekWatch/Package.swift", true],
    ["packages/mobile/native/SomeNativeInput.swift", true],
    ["packages/mobile/modules/health-kit/expo-module.config.json", true],
    ["packages/mobile/modules/health-kit/ios/HealthKitModule.swift", true],
    ["packages/mobile/app/settings.tsx", false],
    ["packages/mobile/components/MetricCard.tsx", false],
    ["packages/mobile/modules/health-kit/src/HealthKitModule.ts", false],
    ["packages/format/package.json", false],
  ] as const;

  for (const [path, shouldDeploy] of cases) {
    it(`${shouldDeploy ? "deploys a binary for" : "keeps OTA-only"} ${path}`, () => {
      expect(nativeInputPattern.test(path)).toBe(shouldDeploy);
    });
  }
});
