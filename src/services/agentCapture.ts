import { createPersonalAgent } from './personalAgent';
import type { AgentCaptureInput } from './personalAgent';
import { TodoService } from './todos';
import { Repository } from '../persistence/repository';

let captureGeneration=0;
const readIdentity=()=>`${Repository.getReadIdentity().split(':')[0]}:${captureGeneration}`;
export function invalidateAgentCaptures(){captureGeneration++;}
const local=createPersonalAgent({todos:TodoService,repository:Repository,readIdentity});
const enhanced=createPersonalAgent({todos:TodoService,repository:Repository,readIdentity,model:async input=>{
  if(!window.electronAPI?.captureAgentModel)throw new Error('当前安装包尚未提供随心记下模型接口。');
  return window.electronAPI.captureAgentModel(input);
}});
export function clearLifeCaptureFocus(){local.clearFocus('life');enhanced.clearFocus('life');}

/** Original input is persisted by the caller before interpretation. Never send another space. */
export async function capturePersonalText(input:AgentCaptureInput,modelEnabled:boolean){
  const service=modelEnabled&&typeof window!=='undefined'&&window.electronAPI?.captureAgentModel?enhanced:local;
  const result=await service.capture({...input,useModel:modelEnabled,expectedIdentity:readIdentity()});
  const created=result.created[0];
  // A provider's prose is not proof of a saved record, enabled alarm or confirmed deal.
  const message=!result.silent&&!result.needsChoice
    ? result.needsReview?'原文已记下，重要业务变更仍待核对。'
      : result.created.length?`已记下 ${result.created.length} 件事。${result.created.some(t=>!t.dueAt)?'未设提醒的事项，时间可以以后再补。':''}`
        : result.changed.length?'已更新对应事项。':'已记下。'
    : result.silent?undefined:result.message;
  return {...result,message,created,allCreated:result.created,needsTime:created?.needsTime?created:undefined,
    handled:result.handled&&!result.needsReview};
}
