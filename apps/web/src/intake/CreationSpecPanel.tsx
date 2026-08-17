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
import { InlineError } from '@/components/InlineError';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

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
    <section className="max-w-[760px] border-t border-border pt-3" aria-labelledby="spec-heading">
      <div className="flex items-center justify-between">
        <h3 id="spec-heading" className="text-[15px] font-semibold">
          创作要求
        </h3>
        {!editing && (
          <Button variant="outline" size="sm" onClick={startEdit}>
            编辑
          </Button>
        )}
      </div>

      {error && <InlineError className="mt-2">{error}</InlineError>}

      {editing ? (
        <div className="mt-2 flex flex-col gap-2.5">
          <label className="flex flex-col gap-1 text-[13px] text-muted-foreground">
            故事前提
            <Textarea
              value={draft.premise}
              onChange={(e) => field('premise', e.target.value)}
              rows={4}
            />
          </label>
          <label className="flex flex-col gap-1 text-[13px] text-muted-foreground">
            类型（用逗号或顿号分隔）
            <Input value={draft.genre} onChange={(e) => field('genre', e.target.value)} />
          </label>
          <label className="flex flex-col gap-1 text-[13px] text-muted-foreground">
            基调（用逗号或顿号分隔）
            <Input value={draft.tone} onChange={(e) => field('tone', e.target.value)} />
          </label>
          <label className="flex flex-col gap-1 text-[13px] text-muted-foreground">
            主题（可留空）
            <Input value={draft.themes} onChange={(e) => field('themes', e.target.value)} />
          </label>
          <label className="flex flex-col gap-1 text-[13px] text-muted-foreground">
            目标读者
            <Input
              value={draft.targetAudience}
              onChange={(e) => field('targetAudience', e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1 text-[13px] text-muted-foreground">
            单章目标字数（可留空，500–40,000）
            <Input
              inputMode="numeric"
              value={draft.chapterLengthTarget}
              onChange={(e) => field('chapterLengthTarget', e.target.value)}
              placeholder="例如 15000"
            />
          </label>
          <label className="flex flex-col gap-1 text-[13px] text-muted-foreground">
            单章最少字数（可留空）
            <Input
              inputMode="numeric"
              value={draft.chapterLengthMinimum}
              onChange={(e) => field('chapterLengthMinimum', e.target.value)}
              placeholder="例如 14000"
            />
          </label>
          <label className="flex flex-col gap-1 text-[13px] text-muted-foreground">
            单章最多字数（可留空）
            <Input
              inputMode="numeric"
              value={draft.chapterLengthMaximum}
              onChange={(e) => field('chapterLengthMaximum', e.target.value)}
              placeholder="例如 16000"
            />
          </label>
          <label className="flex flex-col gap-1 text-[13px] text-muted-foreground">
            结构（可留空）
            <Textarea
              value={draft.structure}
              onChange={(e) => field('structure', e.target.value)}
              rows={2}
            />
          </label>
          <div className="flex gap-2">
            <Button onClick={() => void save()} disabled={saving}>
              {saving ? '保存中…' : '保存'}
            </Button>
            <Button variant="outline" onClick={cancelEdit} disabled={saving}>
              取消
            </Button>
          </div>
        </div>
      ) : (
        <dl className="mt-2 [&_dd]:mt-0.5 [&_dd]:mb-2.5 [&_dd]:whitespace-pre-wrap [&_dt]:text-xs [&_dt]:text-muted-foreground">
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
