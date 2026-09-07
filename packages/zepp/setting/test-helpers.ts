import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";

export async function renderSettingsInSandbox(
  entryPoint: URL,
  values: Readonly<Record<string, string>>,
) {
  const { outputFiles } = await build({
    entryPoints: [fileURLToPath(entryPoint)],
    bundle: true,
    platform: "neutral",
    target: "es2022",
    format: "iife",
    write: false,
  });
  const bundle = outputFiles[0];
  if (!bundle) throw new Error("Settings bundle was not generated");
  const images: Record<string, unknown>[] = [];
  const buttons: Array<{
    label?: string;
    onClick?: () => void;
  }> = [];
  const inputs: Array<{
    label?: string;
    onChange?: (value: string) => void;
  }> = [];
  const storedValues = new Map(Object.entries(values));
  const settingsStorage = {
    getItem: (key: string) => storedValues.get(key) ?? null,
    setItem: (key: string, value: string) => storedValues.set(key, value),
  };
  const components = {
    AppSettingsPage(configuration: {
      build(props: { settingsStorage: typeof settingsStorage }): unknown;
    }) {
      configuration.build({ settingsStorage });
    },
    View: (props: unknown, children: unknown[]) => ({ props, children }),
    Button: (props: (typeof buttons)[number]) => {
      buttons.push(props);
      return props;
    },
    TextInput: (props: (typeof inputs)[number]) => {
      inputs.push(props);
      return props;
    },
    Link: (props: unknown, children: unknown[]) => ({ props, children }),
    Image: (props: Record<string, unknown>) => {
      images.push(props);
      return props;
    },
  };

  // Zepp injects components as lexical bindings and shadows unsupported globals.
  runInNewContext(
    `(function ({ AppSettingsPage, View, Button, TextInput, Link, Image }) {
      var Reflect, globalThis;
      ${bundle.text}
    })(components);`,
    { components },
  );
  return { buttons, images, inputs, storage: settingsStorage };
}
