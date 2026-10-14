import type { SidecarService } from "./types.js";

export interface BuildJobManifestInput {
  namespace: string;
  jobName: string;
  adapterType: string;
  image: string;
  envSecretName: string;
  serviceAccountName: string;
  labels: Record<string, string>;
  resources: {
    requests?: { cpu?: string; memory?: string };
    limits?: { cpu?: string; memory?: string };
  };
  runtimeClassName?: string;
  activeDeadlineSec: number;
  ttlSecondsAfterFinished: number;
  imagePullSecrets?: string[];
  services?: SidecarService[];
}

function serviceVolumeName(service: SidecarService, index: number): string {
  return `svc-${service.name}-${index}`;
}

function buildSidecar(service: SidecarService): Record<string, unknown> {
  const user = service.user ?? 1000;
  return {
    name: service.name,
    image: service.image,
    imagePullPolicy: "IfNotPresent",
    restartPolicy: "Always",
    ...(service.command ? { command: service.command } : {}),
    ...(service.args ? { args: service.args } : {}),
    env: Object.entries(service.env).map(([name, value]) => ({ name, value })),
    ...(service.readyCommand
      ? { startupProbe: { exec: { command: service.readyCommand }, periodSeconds: 2, failureThreshold: 90 } }
      : {}),
    securityContext: {
      runAsNonRoot: true,
      runAsUser: user,
      runAsGroup: user,
      allowPrivilegeEscalation: false,
      capabilities: { drop: ["ALL"] },
    },
    volumeMounts: service.volumes.map((mountPath, index) => ({ name: serviceVolumeName(service, index), mountPath })),
  };
}

export function buildJobManifest(input: BuildJobManifestInput): Record<string, unknown> {
  const podLabels = {
    ...input.labels,
    "paperclip.io/role": "agent",
  };
  const services = input.services ?? [];
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name: input.jobName,
      namespace: input.namespace,
      labels: { ...input.labels },
    },
    spec: {
      backoffLimit: 0,
      ttlSecondsAfterFinished: input.ttlSecondsAfterFinished,
      activeDeadlineSeconds: input.activeDeadlineSec,
      template: {
        metadata: { labels: podLabels },
        spec: {
          serviceAccountName: input.serviceAccountName,
          // Agent containers call back to paperclip-server via HTTPS egress;
          // they never call the Kubernetes API, so mounting an SA token is
          // unnecessary attack surface.
          automountServiceAccountToken: false,
          restartPolicy: "Never",
          ...(input.runtimeClassName ? { runtimeClassName: input.runtimeClassName } : {}),
          ...(input.imagePullSecrets && input.imagePullSecrets.length > 0
            ? { imagePullSecrets: input.imagePullSecrets.map((name) => ({ name })) }
            : {}),
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 1000,
            runAsGroup: 1000,
            fsGroup: 1000,
            fsGroupChangePolicy: "OnRootMismatch",
            seccompProfile: { type: "RuntimeDefault" },
          },
          ...(services.length > 0 ? { initContainers: services.map(buildSidecar) } : {}),
          containers: [
            {
              name: "agent",
              image: input.image,
              imagePullPolicy: "IfNotPresent",
              command: ["/usr/bin/tini", "--", "/usr/local/bin/paperclip-agent-shim"],
              // HOME must point at a writable mount; the image's default
              // HOME is inside the readOnly root filesystem. Agent runtimes
              // can silently exit with code 0 and no output when HOME is
              // unwritable, so set this explicitly.
              env: [{ name: "HOME", value: "/home/paperclip" }],
              envFrom: [{ secretRef: { name: input.envSecretName } }],
              securityContext: {
                runAsNonRoot: true,
                runAsUser: 1000,
                runAsGroup: 1000,
                readOnlyRootFilesystem: true,
                allowPrivilegeEscalation: false,
                capabilities: { drop: ["ALL"] },
              },
              resources: {
                requests: input.resources.requests ?? { cpu: "250m", memory: "512Mi" },
                limits: input.resources.limits ?? { cpu: "2", memory: "4Gi" },
              },
              volumeMounts: [
                { name: "workspace", mountPath: "/workspace" },
                { name: "home", mountPath: "/home/paperclip" },
                { name: "cache", mountPath: "/home/paperclip/.cache" },
                { name: "tmp", mountPath: "/tmp" },
              ],
            },
          ],
          volumes: [
            { name: "workspace", emptyDir: { sizeLimit: "8Gi" } },
            { name: "home", emptyDir: { sizeLimit: "1Gi" } },
            { name: "cache", emptyDir: { sizeLimit: "1Gi" } },
            { name: "tmp", emptyDir: { sizeLimit: "2Gi" } },
            ...services.flatMap((service) =>
              service.volumes.map((_, index) => ({ name: serviceVolumeName(service, index), emptyDir: { sizeLimit: "4Gi" } })),
            ),
          ],
        },
      },
    },
  };
}
