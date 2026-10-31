import React from 'react';
import type { CompanionState } from '../services/companionState';
import './companion.css';

export interface CompanionProps {
  state: CompanionState;
  mode: 'life' | 'work';
  name?: string;
  compact?: boolean;
  onToggle?: () => void;
  onOpenMemory?: () => void;
  reminderCount?: number;
  /** Optional operation detail, displayed only in the expanded interface. */
  statusText?: string;
}

const stateLabels: Record<CompanionState, string> = {
  idle: '安静待机', thinking: '正在整理', review: '待核对',
  saved: '已确认保存', reminder: '待跟进提醒', error: '需要处理',
};

function Character({ state }: { state: CompanionState }) {
  const closedEyes = state === 'saved';
  return <div className="looma-companion__figure" aria-hidden="true">
    <svg className="looma-companion__drawing" viewBox="0 0 180 180" focusable="false">
      <ellipse className="looma-companion__ground" cx="91" cy="161" rx="43" ry="7"/>
      <circle className="looma-companion__halo" cx="90" cy="91" r="65"/>
      <path className="looma-companion__orbit" d="M28 93a63 63 0 0 1 44-60m48 112a63 63 0 0 0 31-43"/>
      <g className="looma-companion__sprite">
        <path className="looma-companion__limb" d={state === 'saved' ? 'M49 103Q27 97 31 80Q33 73 39 79L54 94' : 'M48 102Q31 106 34 117Q38 123 50 112'}/>
        <path className="looma-companion__limb" d={state === 'saved' ? 'M130 103Q151 97 148 80Q146 73 140 79L126 94' : 'M131 102Q148 107 145 118Q141 124 129 113'}/>
        <path className="looma-companion__foot" d="M67 139Q60 158 73 158Q82 158 83 143m21-1q-1 16 10 16q13-1 4-21"/>
        <path className="looma-companion__body" d="M83 48C112 43 133 60 137 87C142 113 133 142 111 148C89 155 62 149 49 131C36 113 39 84 51 65C59 53 69 48 83 48Z"/>
        <path className="looma-companion__belly" d="M62 121C65 135 90 143 112 130C107 143 74 147 62 131Z"/>
        <path className="looma-companion__leaf-stem" d="M87 49Q86 38 91 29"/>
        <path className="looma-companion__leaf" d="M88 42C72 42 65 28 70 18C86 18 96 29 88 42Z"/>
        <path className="looma-companion__leaf-light" d="M89 39C88 23 102 16 114 19C112 32 104 41 89 39Z"/>
        <path className="looma-companion__leaf-vein" d="M77 26L88 40L105 25"/>
        <ellipse className="looma-companion__blush" cx="62" cy="108" rx="9" ry="5"/>
        <ellipse className="looma-companion__blush" cx="117" cy="108" rx="9" ry="5"/>
        {closedEyes ? <g className="looma-companion__face-line"><path d="M65 96q6-8 12 0m24 0q6-8 12 0"/><path d="M83 109q7 7 14 0"/></g> : <>
          <g className="looma-companion__eyes">
            <ellipse cx={state === 'thinking' ? 74 : 71} cy="96" rx="4" ry={state === 'error' ? 5 : 6}/>
            <ellipse cx={state === 'thinking' ? 110 : 107} cy="96" rx="4" ry={state === 'error' ? 5 : 6}/>
          </g>
          <g className="looma-companion__eye-light"><circle cx="72" cy="94" r="1.3"/><circle cx="108" cy="94" r="1.3"/></g>
          <path className="looma-companion__face-line" d={state === 'error' ? 'M84 112q6-3 12 0M66 85l10-3m25 0l10 3' : state === 'thinking' ? 'M87 111q3 2 6 0' : 'M83 109q7 6 14 0'}/>
        </>}
        {state === 'review' ? <g className="looma-companion__paper">
          <path d="M112 116l23 3-3 28-24-3Z"/>
          <path className="looma-companion__paper-line" d="M117 125l11 1m-12 6l10 1m-11 6l6 1"/>
          <path className="looma-companion__limb" d="M127 113q-11 4-8 10q4 6 13 0"/>
        </g> : null}
        {state === 'saved' ? <g className="looma-companion__sparkle"><path d="M144 47v12m-6-6h12M34 67v8m-4-4h8"/><path className="looma-companion__check" d="M118 49l5 5 10-11"/></g> : null}
        {state === 'reminder' ? <g className="looma-companion__bell"><path d="M139 61q-9 0-9 11v5l-3 4h24l-3-4v-5q0-11-9-11Z"/><path d="M136 85q3 4 6 0m-3-27v3"/></g> : null}
        {state === 'error' ? <g className="looma-companion__alert"><circle cx="140" cy="65" r="12"/><path d="M140 58v8m0 5v1"/></g> : null}
      </g>
      {state === 'thinking' ? <g className="looma-companion__thinking-dots"><circle cx="129" cy="45" r="3"/><circle cx="140" cy="40" r="3"/><circle cx="151" cy="43" r="3"/></g> : null}
    </svg>
  </div>;
}

function MemoryIcon() {
  return <svg viewBox="0 0 20 20" width="17" height="17" fill="none" aria-hidden="true" focusable="false"><path d="M10 5C7 3.5 4 4 2.5 4.5v11C5 15 7.5 15 10 16.5m0-11.5c3-1.5 6-1 7.5-.5v11c-2.5-.5-5-.5-7.5 1m0-11.5v11.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg>;
}

export function Companion({ state, mode, name = 'Looma', compact = false, onToggle, onOpenMemory, reminderCount = 0, statusText }: CompanionProps) {
  const displayName = name.trim().slice(0, 24) || 'Looma';
  const count = Number.isFinite(reminderCount) ? Math.max(0, Math.floor(reminderCount)) : 0;
  const countText = count > 99 ? '99+' : String(count);
  const label = stateLabels[state];
  const genericDetail = state === 'reminder'
    ? count > 0 ? `${countText} 项待跟进` : '查看提醒事项'
    : state === 'idle' ? mode === 'work' ? '随时记下，继续跟进' : '我在，慢慢说'
    : state === 'thinking' ? '整理完成后请你核对'
    : state === 'review' ? '由你确认，再记住'
    : state === 'saved' ? '这次记录已保存'
    : '请查看操作提示';
  // A desktop capsule is visible outside the main workspace: never include operation details.
  const detail = compact ? genericDetail : statusText?.trim() || genericDetail;
  const contents = <>
    <Character state={state}/>
    <div className="looma-companion__copy">
      <div className="looma-companion__identity"><strong>{displayName}</strong><span>{mode === 'work' ? '工作' : '生活'}</span></div>
      <div className="looma-companion__status" role="status" aria-live="polite" aria-atomic="true"><span className="looma-companion__state"><i aria-hidden="true"/>{label}</span><span className="looma-companion__detail">{detail}</span></div>
    </div>
  </>;
  return <section className={`looma-companion${compact ? ' looma-companion--compact' : ''}`} data-state={state} data-mode={mode} aria-label={`${displayName} 伴侣`}>
    {compact && onToggle ? <button className="looma-companion__restore" type="button" onClick={onToggle} aria-label={`展开 ${displayName}`} title="展开工作台">{contents}</button> : <div className="looma-companion__presence">{contents}</div>}
    {onOpenMemory || (!compact && onToggle) ? <div className="looma-companion__actions">
      {onOpenMemory ? <button className="looma-companion__memory" type="button" onClick={onOpenMemory} aria-label="打开记忆与档案" title="记忆与档案"><MemoryIcon/>{compact ? null : <span>记忆与档案</span>}</button> : null}
      {!compact && onToggle ? <button className="looma-companion__fold" type="button" onClick={onToggle} aria-label="收起为伴侣胶囊" title="收起为伴侣胶囊"><span aria-hidden="true">↙</span><span>收起</span></button> : null}
    </div> : null}
  </section>;
}
