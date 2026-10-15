import type { SidecarService } from "./types.js";

function serviceVolumeName(service: SidecarService, index: number): string {
  return `svc-${service.name}-${index}`;
}

export function buildSidecars(services: SidecarService[]): Record<string, unknown>[] {
  return services.map((service) => {
    const user = service.user ?? 1000;
    return {
      name: service.name,
      image: service.image,
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
  });
}

export function buildAgentVolumes(services: SidecarService[]): Record<string, unknown>[] {
  return [
    { name: "workspace", emptyDir: { sizeLimit: "8Gi" } },
    { name: "home", emptyDir: { sizeLimit: "4Gi" } },
    { name: "cache", emptyDir: { sizeLimit: "1Gi" } },
    { name: "tmp", emptyDir: { sizeLimit: "4Gi" } },
    ...services.flatMap((service) =>
      service.volumes.map((_, index) => ({ name: serviceVolumeName(service, index), emptyDir: { sizeLimit: "4Gi" } })),
    ),
  ];
}
