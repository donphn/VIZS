import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";

/**
 * Photon credentials. The project's .env uses PHOTON_PROJECT_ID / PHOTON_SECRET_KEY
 * (the "PROJECT_ID" / "SECRET_KEY" values from Settings at https://app.photon.codes).
 * The SDK's native names, SPECTRUM_PROJECT_ID / SPECTRUM_PROJECT_SECRET, are
 * accepted as a fallback.
 */
export function readPhotonCredentials(env: NodeJS.ProcessEnv = process.env): {
  projectId: string;
  projectSecret: string;
} {
  const projectId = (env.PHOTON_PROJECT_ID ?? env.SPECTRUM_PROJECT_ID ?? "").trim();
  const projectSecret = (env.PHOTON_SECRET_KEY ?? env.SPECTRUM_PROJECT_SECRET ?? "").trim();
  const missing: string[] = [];
  if (!projectId) missing.push("PHOTON_PROJECT_ID");
  if (!projectSecret) missing.push("PHOTON_SECRET_KEY");
  if (missing.length > 0) {
    throw new Error(
      `Missing Photon credentials: ${missing.join(", ")}. ` +
        "Copy PROJECT_ID and SECRET_KEY from your project's Settings at https://app.photon.codes into .env.",
    );
  }
  return { projectId, projectSecret };
}

/**
 * Create and authenticate a Spectrum app with the Spectrum Cloud iMessage provider.
 * Env is read when this is called, not at import time.
 * Inbound messages arrive over a gRPC stream (`app.messages`), so the app needs no public URL.
 */
export async function createSpectrumClient() {
  const { projectId, projectSecret } = readPhotonCredentials();
  return Spectrum({
    projectId,
    projectSecret,
    providers: [imessage.config()],
  });
}

export type SpectrumClient = Awaited<ReturnType<typeof createSpectrumClient>>;
