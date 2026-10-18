// One repo, two services: SEALED_ROLE=sealer runs the sealer, anything else runs the API.
if (process.env.SEALED_ROLE === "sealer") await import("./sealer/main.js");
else await import("./server/main.js");
