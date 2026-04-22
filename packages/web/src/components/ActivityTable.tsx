import { useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";

export interface ActivityTableColumn<Row> {
  key: string;
  label: string;
  headerClassName?: string;
  cellClassName?: string;
  renderCell: (row: Row) => ReactNode;
}

interface ActivityTableProps<Row> {
  rows: Row[];
  columns: ActivityTableColumn<Row>[];
  getRowKey: (row: Row) => string;
  getActivityId: (row: Row) => string;
  tableClassName?: string;
  containerClassName?: string;
  headerRowClassName?: string;
  rowClassName?: string | ((row: Row) => string);
  footer?: ReactNode;
}

export function ActivityTable<Row>({
  rows,
  columns,
  getRowKey,
  getActivityId,
  tableClassName = "w-full text-sm",
  containerClassName = "overflow-x-auto",
  headerRowClassName = "border-b border-border text-left text-xs text-muted uppercase tracking-wider",
  rowClassName = "border-b border-border/50 hover:bg-surface-hover cursor-pointer",
  footer,
}: ActivityTableProps<Row>) {
  const navigate = useNavigate();

  const navigateToActivity = (activityId: string) => {
    navigate({ to: "/activity/$id", params: { id: activityId } });
  };

  return (
    <div className={containerClassName}>
      <table className={tableClassName}>
        <thead>
          <tr className={headerRowClassName}>
            {columns.map((column) => (
              <th key={column.key} scope="col" className={column.headerClassName}>
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const activityId = getActivityId(row);
            return (
              <tr
                key={getRowKey(row)}
                onClick={() => navigateToActivity(activityId)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    navigateToActivity(activityId);
                  }
                }}
                tabIndex={0}
                className={typeof rowClassName === "function" ? rowClassName(row) : rowClassName}
              >
                {columns.map((column) => (
                  <td key={column.key} className={column.cellClassName}>
                    {column.renderCell(row)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
      {footer}
    </div>
  );
}
