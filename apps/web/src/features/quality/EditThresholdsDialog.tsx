import { LoaderCircle } from 'lucide-react';
import { useId, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { actionErrorText } from '@/features/pipeline/pipeline-labels';
import { FormError } from '@/features/pipeline/SqlActions';
import type { QualityRulesView } from '@/lib/api-types';

import { useSaveQualityRules } from './queries';
import {
  DEFAULT_ROW,
  inputLabel,
  overridesOf,
  rowFromOverride,
  ruleName,
  validateRow,
  type RowErrors,
  type RuleRow,
  type RuleSpec,
} from './threshold-form';

function rowsOf(view: QualityRulesView): Record<string, RuleRow> {
  return Object.fromEntries(
    view.catalogue.map(({ rule }) => [rule, rowFromOverride(view.rules[rule])]),
  );
}

function NumberField({
  label,
  value,
  error,
  disabled,
  max,
  onChange,
}: {
  label: string;
  value: string;
  error: string | undefined;
  disabled: boolean;
  max: number;
  onChange: (value: string) => void;
}) {
  const id = useId();
  const errorId = useId();
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      <Input
        id={id}
        type="number"
        inputMode="decimal"
        min={0}
        max={max}
        step="any"
        placeholder="Default"
        className="w-28"
        value={value}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
      {error && (
        <p id={errorId} className="max-w-48 text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

function RuleFields({
  spec,
  row,
  errors,
  onChange,
}: {
  spec: RuleSpec;
  row: RuleRow;
  errors: RowErrors;
  onChange: (row: RuleRow) => void;
}) {
  const name = ruleName(spec.rule);
  return (
    <fieldset className="space-y-2 border-t px-1 py-3 first:border-t-0">
      <legend className="sr-only">{name}</legend>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p aria-hidden="true" className="text-sm font-medium">
          {name}
        </p>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-label={`Reset ${name} to default`}
          onClick={() => {
            onChange(DEFAULT_ROW);
          }}
        >
          Reset to default
        </Button>
      </div>
      <div className="flex flex-wrap items-start gap-4">
        <label className="flex items-center gap-2 pt-5 text-sm">
          <input
            type="checkbox"
            className="size-4 accent-primary"
            checked={row.enabled}
            onChange={(event) => {
              onChange({ ...row, enabled: event.target.checked });
            }}
          />
          Check this rule
        </label>
        <NumberField
          label={inputLabel('warn', spec)}
          value={row.warn}
          error={errors.warn}
          disabled={!row.enabled}
          max={spec.max}
          onChange={(warn) => {
            onChange({ ...row, warn });
          }}
        />
        <NumberField
          label={inputLabel('fail', spec)}
          value={row.neverFails ? '' : row.fail}
          error={errors.fail}
          disabled={!row.enabled || row.neverFails}
          max={spec.max}
          onChange={(fail) => {
            onChange({ ...row, fail });
          }}
        />
        <label className="flex items-center gap-2 pt-5 text-sm">
          <input
            type="checkbox"
            className="size-4 accent-primary"
            checked={row.neverFails}
            disabled={!row.enabled}
            onChange={(event) => {
              onChange({ ...row, neverFails: event.target.checked });
            }}
          />
          Only warn, never fail
        </label>
      </div>
    </fieldset>
  );
}

function ThresholdsForm({
  projectId,
  view,
  onSaved,
}: {
  projectId: string;
  view: QualityRulesView;
  onSaved: () => void;
}) {
  const save = useSaveQualityRules(projectId);
  const [rows, setRows] = useState(() => rowsOf(view));
  const [errors, setErrors] = useState<Record<string, RowErrors>>({});
  const [formError, setFormError] = useState<string | null>(null);

  return (
    <form
      noValidate
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        const found: Record<string, RowErrors> = {};
        for (const spec of view.catalogue) {
          const rowErrors = validateRow(rows[spec.rule] ?? DEFAULT_ROW, spec);
          if (Object.keys(rowErrors).length > 0) found[spec.rule] = rowErrors;
        }
        setErrors(found);
        if (Object.keys(found).length > 0) {
          setFormError('Some values need fixing. Check the messages under the fields.');
          return;
        }
        setFormError(null);
        save.mutate(
          { rules: overridesOf(rows), fields: view.fields },
          {
            onSuccess: onSaved,
            onError: (error) => {
              setFormError(actionErrorText(error));
            },
          },
        );
      }}
    >
      <div className="max-h-[60vh] overflow-y-auto">
        {view.catalogue.map((spec) => (
          <RuleFields
            key={spec.rule}
            spec={spec}
            row={rows[spec.rule] ?? DEFAULT_ROW}
            errors={errors[spec.rule] ?? {}}
            onChange={(row) => {
              setRows((current) => ({ ...current, [spec.rule]: row }));
            }}
          />
        ))}
      </div>
      <FormError message={formError} />
      <DialogFooter>
        <DialogClose asChild>
          <Button type="button" variant="outline">
            Cancel
          </Button>
        </DialogClose>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending && <LoaderCircle aria-hidden="true" className="animate-spin" />}
          Save thresholds
        </Button>
      </DialogFooter>
    </form>
  );
}

/** "Edit thresholds": turn rules on or off and set warn / fail per rule; saved with PUT. */
export function EditThresholdsDialog({
  projectId,
  view,
  onSaved,
}: {
  projectId: string;
  view: QualityRulesView;
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline">
          Edit thresholds
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Edit thresholds</DialogTitle>
          <DialogDescription>
            Leave a value empty to use the default. Changes apply from the next quality check and
            are recorded in the audit log.
          </DialogDescription>
        </DialogHeader>
        {/* Mounted while open, so every opening starts from the saved settings. */}
        {open && (
          <ThresholdsForm
            projectId={projectId}
            view={view}
            onSaved={() => {
              setOpen(false);
              onSaved();
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
