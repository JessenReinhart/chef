import { formatDoctor, runDoctor } from "./doctor.ts";

const result = await runDoctor();
console.log(formatDoctor(result));
if (!result.ok) process.exitCode = 1;
