/**
 * CreationSpec（创作要求）展示与编辑面板（B4）。
 *
 * 编辑走 contract.updateByUser（CAS：expectedContractVersion），成功后显式触发
 * intake.propagateSpecInvalidation 失效级联（D-B4-4）。V1 可编辑：前提 / 目标读者 /
 * 结构（set-scalar）+ 单章目标/范围（set-structured）+ 类型 / 基调 / 主题
 * （set-string-list）；其余字段只读展示。
 */

import { useCallback, useState } from 'react';
import type { ContractPatchOperationDTO, ContractVersionPublicData } from '@ai-novel/contracts';
import { formatChapterLength } from '../contract/contract-labels';
import { toSafeUserError } from '../safety/safe-error';

export interface CreationSpecPanelProps {
  readonly projectId: string;
  readonly spec: ContractVersionPublicData;
  readonly onSaved: () => void | Promise<void>;
}

/** 逗号/顿号分隔的列表输入 → 去空规整 */
export function parseListInput(raw: string): string[] {
  return raw
    .split(/[,，、]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

interface DraftFields {
  premise: string;
  targetAudience: string;
  structure: string;
  chapterLengthTarget: string;
  chapterLengthMinimum: string;
  chapterLengthMaximum: string;
  genre: string;
  tone: string;
  themes: string;
}

function draftFromSpec(spec: ContractVersionPublicData): DraftFields {
  return {
    premise: spec.sections.premise,
    targetAudience: spec.sections.targetAudience,
    structure: spec.sections.structure ?? '',
    chapterLengthTarget: spec.sections.chapterLength?.targetCharacters.toString() ?? '',
    chapterLengthMinimum: spec.sections.chapterLength?.minimumCharacters?.toString() ?? '',
    chapterLengthMaximum: spec.sections.chapterLength?.maximumCharacters?.toString() ?? '',
    genre: spec.sections.genre.join('、'),
    tone: spec.sections.tone.join('、'),
    themes: (spec.sections.themes ?? []).join('、'),
  };
}

function parseChapterCharacters(raw: string, label: string): number | undefined {
  const normalized = raw.trim().replace(/[，,]/g, '');
  if (normalized.length === 0) return undefined;
  const value = Number(normalized);
  if (!Number.isSafeInteger(value) || value < 500 || value > 40_000) {
    throw new Error(`${label}必须是 500 到 40,000 之间的整数`);
  }
  return value;
}

/** 由草稿字段构造变更操作集（仅包含实际变化的字段） */
export function buildSpecOperations(
  spec: ContractVersionPublicData,
  draft: DraftFields,
): ContractPatchOperationDTO[] {
  const ops: ContractPatchOperationDTO[] = [];
  if (draft.premise.trim() !== spec.sections.premise) {
    ops.push({ kind: 'set-scalar', path: '/premise', value: draft.premise.trim() });
  }
  if (draft.targetAudience.trim() !== spec.sections.targetAudience) {
    ops.push({ kind: 'set-scalar', path: '/targetAudience', value: draft.targetAudience.trim() });
  }
  const structure = draft.structure.trim();
  if (structure.length > 0 && structure !== (spec.sections.structure ?? '')) {
    ops.push({ kind: 'set-scalar', path: '/structure', value: structure });
  }
  const targetCharacters = parseChapterCharacters(draft.chapterLengthTarget, '单章目标字数');
  const minimumCharacters = parseChapterCharacters(draft.chapterLengthMinimum, '单章最少字数');
  const maximumCharacters = parseChapterCharacters(draft.chapterLengthMaximum, '单章最多字数');
  if (targetCharacters === undefined && spec.sections.chapterLength) {
    ops.push({ kind: 'remove-field', path: '/chapterLength' });
  } else if (
    targetCharacters === undefined &&
    (minimumCharacters !== undefined || maximumCharacters !== undefined)
  ) {
    throw new Error('填写单章字数范围前，请先填写单章目标字数');
  } else if (targetCharacters !== undefined) {
    if (minimumCharacters !== undefined && minimumCharacters > targetCharacters) {
      throw new Error('单章最少字数不能大于目标字数');
    }
    if (maximumCharacters !== undefined && maximumCharacters < targetCharacters) {
      throw new Error('单章最多字数不能小于目标字数');
    }
    const chapterLength = {
      targetCharacters,
      ...(minimumCharacters !== undefined && { minimumCharacters }),
      ...(maximumCharacters !== undefined && { maximumCharacters }),
    };
    if (
      chapterLength.targetCharacters !== spec.sections.chapterLength?.targetCharacters ||
      chapterLength.minimumCharacters !== spec.sections.chapterLength?.minimumCharacters ||
      chapterLength.maximumCharacters !== spec.sections.chapterLength?.maximumCharacters
    ) {
      ops.push({
        kind: 'set-structured',
        path: '/chapterLength',
        value: chapterLength,
      });
    }
  }
  const genre = parseListInput(draft.genre);
  if (genre.join('\u0000') !== spec.sections.genre.join('\u0000')) {
    ops.push({ kind: 'set-string-list', path: '/genre', value: genre });
  }
  const tone = parseListInput(draft.tone);
  if (tone.join('\u0000') !== spec.sections.tone.join('\u0000')) {
    ops.push({ kind: 'set-string-list', path: '/tone', value: tone });
  }
  const themes = parseListInput(draft.themes);
  if (themes.length > 0 && themes.join('\u0000') !== (spec.sections.themes ?? []).join('\u0000')) {
    ops.push({ kind: 'set-string-list', path: '/themes', value: themes });
  }
  return ops;
}

export function CreationSpecPanel({ projectId, spec, onSaved }: CreationSpecPanelProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<DraftFields>(() => draftFromSpec(spec));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const startEdit = useCallback(() => {
    setDraft(draftFromSpec(spec));
    setError(null);
    setEditing(true);
  }, [spec]);

  const cancelEdit = useCallback(() => {
    setEditing(false);
    setError(null);
  }, []);

  const save = useCallback(async () => {
    let operations: ContractPatchOperationDTO[];
    try {
      operations = buildSpecOperations(spec, draft);
    } catch (err) {
      setError(toSafeUserError(err, '创作要求格式不正确').message);
      return;
    }
    if (operations.length === 0) {
      setEditing(false);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const next = await window.desktop.contract.updateByUser({
        projectId,
        expectedContractVersion: spec.version,
        operations,
      });
      // D-B4-4：编辑成功后显式失效级联（下游调研/蓝图须基于新要求重建）
      await window.desktop.intake.propagateSpecInvalidation({
        projectId,
        creationSpecVersionId: next.id,
      });
      setEditing(false);
      await onSaved();
    } catch (err) {
      setError(toSafeUserError(err, '保存创作要求失败').message);
    } finally {
      setSaving(false);
    }
  }, [projectId, spec, draft, onSaved]);

  const field = (key: keyof DraftFields, value: string) =>
    setDraft((prev) => ({ ...prev, [key]: value }));

  return (
    <section className="spec-panel" aria-labelledby="spec-heading">
      <div className="spec-panel-header">
        <h3 id="spec-heading">创作要求</h3>
        {!editing && (
          <button className="btn-secondary" onClick={startEdit}>
            编辑
          </button>
        )}
      </div>

      {error && (
        <div className="spec-error" role="alert">
          {error}
        </div>
      )}

      {editing ? (
        <div className="spec-edit-form">
          <label>
            故事前提
            <textarea
              value={draft.premise}
              onChange={(e) => field('premise', e.target.value)}
              rows={4}
            />
          </label>
          <label>
            类型（用逗号或顿号分隔）
            <input value={draft.genre} onChange={(e) => field('genre', e.target.value)} />
          </label>
          <label>
            基调（用逗号或顿号分隔）
            <input value={draft.tone} onChange={(e) => field('tone', e.target.value)} />
          </label>
          <label>
            主题（可留空）
            <input value={draft.themes} onChange={(e) => field('themes', e.target.value)} />
          </label>
          <label>
            目标读者
            <input
              value={draft.targetAudience}
              onChange={(e) => field('targetAudience', e.target.value)}
            />
          </label>
          <label>
            单章目标字数（可留空，500–40,000）
            <input
              inputMode="numeric"
              value={draft.chapterLengthTarget}
              onChange={(e) => field('chapterLengthTarget', e.target.value)}
              placeholder="例如 15000"
            />
          </label>
          <label>
            单章最少字数（可留空）
            <input
              inputMode="numeric"
              value={draft.chapterLengthMinimum}
              onChange={(e) => field('chapterLengthMinimum', e.target.value)}
              placeholder="例如 14000"
            />
          </label>
          <label>
            单章最多字数（可留空）
            <input
              inputMode="numeric"
              value={draft.chapterLengthMaximum}
              onChange={(e) => field('chapterLengthMaximum', e.target.value)}
              placeholder="例如 16000"
            />
          </label>
          <label>
            结构（可留空）
            <textarea
              value={draft.structure}
              onChange={(e) => field('structure', e.target.value)}
              rows={2}
            />
          </label>
          <div className="spec-edit-actions">
            <button className="btn-primary" onClick={() => void save()} disabled={saving}>
              {saving ? '保存中…' : '保存'}
            </button>
            <button className="btn-secondary" onClick={cancelEdit} disabled={saving}>
              取消
            </button>
          </div>
        </div>
      ) : (
        <dl className="spec-view">
          <dt>故事前提</dt>
          <dd>{spec.sections.premise}</dd>
          <dt>类型</dt>
          <dd>{spec.sections.genre.join('、') || '—'}</dd>
          <dt>基调</dt>
          <dd>{spec.sections.tone.join('、') || '—'}</dd>
          {spec.sections.themes && spec.sections.themes.length > 0 && (
            <>
              <dt>主题</dt>
              <dd>{spec.sections.themes.join('、')}</dd>
            </>
          )}
          <dt>目标读者</dt>
          <dd>{spec.sections.targetAudience}</dd>
          <dt>主角</dt>
          <dd>{spec.sections.protagonist.name}</dd>
          {spec.sections.structure && (
            <>
              <dt>结构</dt>
              <dd>{spec.sections.structure}</dd>
            </>
          )}
          {spec.sections.chapterLength && (
            <>
              <dt>单章目标字数</dt>
              <dd>{formatChapterLength(spec.sections.chapterLength)}</dd>
            </>
          )}
        </dl>
      )}
    </section>
  );
}
