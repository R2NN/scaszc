import { planningRuntimeStatus } from '../server/runtimeReadiness.mjs';
const status=await planningRuntimeStatus();
process.stdout.write(JSON.stringify(status,null,2)+'\n');
process.exitCode=status.ready?0:2;
