// Human-authored intent oracles; names/items vary, assertions do not come from an LLM.
const names=['陈总','李工','王姐','老周','小林','赵老师','阿杰','刘经理','孙师傅','何女士'];
const things=['电费','水费','燃气费','物业费','停车费','话费','网费','房租','学费','会员费'];
const scenarios=[
 ['explicit-reminder',(n,x)=>`明天下午三点提醒我交${x}`,{created:1,pending:1,timed:true}],
 ['undated-capture',(n,x)=>`帮我记一下，找时间交${x}，现在没空弄`,{created:1,pending:1,timed:false}],
 ['plain-plan',(n,x)=>`我明天可能去交${x}`,{created:1,suggested:1}],
 ['note',(n,x)=>`随手记个信息：${n}喜欢喝无糖茶`,{created:0,changed:0}],
 ['emotion',(n,x)=>`今天跟${n}开会累死了，什么也不想干`,{created:0,changed:0}],
 ['negative',(n,x)=>`${x}还没交，别当成已经完成`,{created:0,changed:0}],
 ['completion-question',(n,x)=>`${x}是不是已经交了`,{created:0,changed:0}],
 ['hypothetical',(n,x)=>`如果${x}已经交了就不用管了，我只是说如果`,{created:0,changed:0}],
 ['uncertain',(n,x)=>`我以为${x}已经交了，结果没交`,{created:0,changed:0}],
 ['completion',(n,x)=>`${x}已经交了`,{created:0,changed:1,status:'completed'}],
 ['cancellation',(n,x)=>`取消交${x}这条待办`,{created:0,changed:1,status:'cancelled'}],
 ['reschedule',(n,x)=>`交${x}那个提醒改到后天下午四点`,{created:0,changed:1,dueAt:'2026-11-07T08:00:00.000Z'}],
 ['rename',(n,x)=>`交${x}那条标题改成核对${x}账单`,{created:0,changed:1,title:`核对${things[0]}账单`,dynamicTitle:true}],
 ['multi-explicit',(n,x)=>`帮我记两件事：交${x}，给${n}发合同，都先记着，不设时间`,{created:2,pending:2,timed:false}],
 ['self-correction',(n,x)=>`帮我记一下买牛奶，还有交${x}，哦牛奶家里还有，牛奶不用记了`,{created:1,pending:1,forbiddenTitle:'牛奶'}],
 ['missing-date',(n,x)=>`下午三点提醒我交${x}，哪一天我还没想好`,{created:1,pending:1,timed:false}],
 ['missing-clock',(n,x)=>`明天提醒我交${x}，几点以后再说`,{created:1,pending:1,timed:false}],
 ['quoted-command',(n,x)=>`举个例子：有人说“${x}已经交了”，这只是例子`,{created:0,changed:0}],
 ['business-review',(n,x)=>`${n}说项目预算是三万元，这只是他提的，我还没答应`,{created:0,changed:0,review:true}],
 ['cross-space',(n,x)=>`别动工作空间的资料，记一下${n}喜欢听雨声`,{created:0,changed:0}],
];
// Creation/suggestion cases start without an already-identical pending task.
// Otherwise a correct deduplicating model and a correct new-capture model would
// be judged against contradictory creation counts. Mutation cases retain targets.
const singles=scenarios.flatMap(([category,wording,expected],g)=>names.map((name,i)=>({id:`single-${g}-${i}`,category,space:i%2?'work':'life',text:wording(name,things[i]),now:'2026-11-05T02:00:00.000Z',seed:expected.created>0?[]:[{id:'target',space:i%2?'work':'life',title:`交${things[i]}`,status:'pending',revision:1,createdAt:1,updatedAt:1,dueAt:'2026-11-06T07:00:00.000Z'}],expected:{...expected,...(expected.dynamicTitle?{title:`核对${things[i]}账单`}:{})}})));
const sessions=Array.from({length:40},(_,i)=>{
 const name=names[i%10],thing=things[i%10],space=i%2?'work':'life',kind=Math.floor(i/10);
 const turns=kind===0?[`帮我记一下交${thing}，暂时不设时间`,'就明天下午三点吧',`${thing}已经交了`]
 :kind===1?[`明天下午三点提醒我给${name}发合同`,'不是明天，是后天下午四点','合同还没发呢，别关掉','合同已经发了']
 :kind===2?[`帮我记一下联系${name}，先不设提醒`,'标题改成跟进合同反馈','先别动，等对方消息','取消跟进合同反馈这个待办']
 :[`帮我记一下交${thing}，还有给${name}发合同，都不设时间`,'交费那个已经处理好了','合同那个还留着'];
 // Independent human oracles: flexible only in incidental title wording, never
 // in record counts, terminal status, or the exact Shanghai reminder timestamp.
 const fee={titleIncludes:[thing],status:'completed',dueAt:kind===0?'2026-11-06T07:00:00.000Z':null};
 const contract={titleIncludes:['合同'],status:kind===1?'completed':'pending',dueAt:kind===1?'2026-11-07T08:00:00.000Z':null};
 const finalRecords=kind===0?[fee]:kind===1?[contract]:kind===2?[{title:'跟进合同反馈',status:'cancelled',dueAt:null}]:[fee,contract];
 const turnStates=kind===0?[{records:1,completed:0,cancelled:0},{records:1,completed:0,cancelled:0},{records:1,completed:1,cancelled:0}]
 :kind===1?[{records:1,completed:0,cancelled:0},{records:1,completed:0,cancelled:0},{records:1,completed:0,cancelled:0},{records:1,completed:1,cancelled:0}]
 :kind===2?[{records:1,completed:0,cancelled:0},{records:1,completed:0,cancelled:0},{records:1,completed:0,cancelled:0},{records:1,completed:0,cancelled:1}]
 :[{records:2,completed:0,cancelled:0},{records:2,completed:1,cancelled:0},{records:2,completed:1,cancelled:0}];
 return{id:`session-${i}`,space,now:'2026-11-05T02:00:00.000Z',turns,expected:{records:kind===3?2:1,completed:kind===0||kind===1||kind===3?1:0,cancelled:kind===2?1:0,finalRecords,turnStates}};
});
module.exports={singles,sessions};
