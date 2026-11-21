import { CircleAlert, LoaderCircle } from 'lucide-react';
import { useState } from 'react';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import type { ColumnMapping, TargetField } from '@/lib/api-types';

import { mappingErrorMessage, TRANSFORM_CODES, transformLabel } from './mapping-labels';
import type { MappingDecisionInput } from './queries';

const RECORD_ID = 'role:source_record_id';
const NOT_MAPPED = 'role:ignore';
const NO_TRANSFORM = '';

const SELECT_CLASS =
  'flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50';

function initialTarget(mapping: ColumnMapping): string {
  const current = mapping.decision ?? mapping.suggestion;
  if (current.role === 'source_record_id') return RECORD_ID;
  if (current.role === 'ignore' || current.target === null) return NOT_MAPPED;
  return `field:${current.target}`;
}

function inputFor(target: string, transform: string): MappingDecisionInput {
  const cleaning = transform === NO_TRANSFORM ? null : transform;
  if (target === RECORD_ID) {
    return { decision: 'override', role: 'source_record_id', target: null, transform: cleaning };
  }
  if (target === NOT_MAPPED) {
    return { decision: 'override', role: 'ignore', target: null, transform: null };
  }
  return {
    decision: 'override',
    role: 'field',
    target: target.slice('field:'.length),
    transform: cleaning,
  };
}

interface ChangeMappingFormProps {
  mapping: ColumnMapping;
  fields: TargetField[];
  pending: boolean;
  error: unknown;
  onSubmit: (input: MappingDecisionInput) => void;
}

function ChangeMappingForm({ mapping, fields, pending, error, onSubmit }: ChangeMappingFormProps) {
  const [target, setTarget] = useState(() => initialTarget(mapping));
  const [transform, setTransform] = useState(
    () => (mapping.decision ?? mapping.suggestion).transform ?? NO_TRANSFORM,
  );
  const mappable = fields.filter((field) => !field.generated);

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(inputFor(target, transform));
      }}
    >
      <div className="space-y-1.5">
        <Label htmlFor="change-target">Map to</Label>
        <select
          id="change-target"
          className={SELECT_CLASS}
          value={target}
          onChange={(event) => {
            setTarget(event.target.value);
          }}
        >
          {mappable.map((field) => (
            <option key={field.name} value={`field:${field.name}`}>
              {field.name} – {field.description}
            </option>
          ))}
          <option value={RECORD_ID}>Record ID (keep to trace records back to this file)</option>
          <option value={NOT_MAPPED}>Not mapped</option>
        </select>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="change-transform">Cleaning</Label>
        <select
          id="change-transform"
          className={SELECT_CLASS}
          value={target === NOT_MAPPED ? NO_TRANSFORM : transform}
          disabled={target === NOT_MAPPED}
          onChange={(event) => {
            setTransform(event.target.value);
          }}
        >
          <option value={NO_TRANSFORM}>None</option>
          {TRANSFORM_CODES.map((code) => (
            <option key={code} value={code}>
              {transformLabel(code)}
            </option>
          ))}
        </select>
      </div>
      {error !== null && (
        <Alert>
          <CircleAlert aria-hidden="true" />
          <AlertDescription>{mappingErrorMessage(error)}</AlertDescription>
        </Alert>
      )}
      <DialogFooter>
        <DialogClose asChild>
          <Button type="button" variant="outline">
            Keep as is
          </Button>
        </DialogClose>
        <Button type="submit" disabled={pending}>
          {pending && <LoaderCircle aria-hidden="true" className="animate-spin" />}
          Save change
        </Button>
      </DialogFooter>
    </form>
  );
}

interface ChangeMappingDialogProps {
  /** The column being changed; null closes the dialog. */
  mapping: ColumnMapping | null;
  fields: TargetField[];
  pending: boolean;
  error: unknown;
  onSubmit: (input: MappingDecisionInput) => void;
  onClose: () => void;
  /** Where keyboard focus goes back to once the dialog closes (the row's Change button). */
  returnFocus: () => void;
}

/** Pick the target by hand: any non-generated field, Record ID or Not mapped, plus cleaning. */
export function ChangeMappingDialog({
  mapping,
  onClose,
  returnFocus,
  ...form
}: ChangeMappingDialogProps) {
  return (
    <Dialog
      open={mapping !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="sm:max-w-md"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          returnFocus();
        }}
      >
        <DialogHeader>
          <DialogTitle>Change mapping</DialogTitle>
          <DialogDescription>
            Choose where <span className="font-mono text-foreground">{mapping?.column}</span> should
            go in the target schema.
          </DialogDescription>
        </DialogHeader>
        {mapping && <ChangeMappingForm key={mapping.column} mapping={mapping} {...form} />}
      </DialogContent>
    </Dialog>
  );
}
