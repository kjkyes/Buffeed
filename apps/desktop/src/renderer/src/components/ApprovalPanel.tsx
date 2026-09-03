import { Check, ShieldAlert, X } from "lucide-react";

import type { Approval } from "../domains/agent";

type ApprovalPanelProps = {
  approvals: Approval[];
  onResolveApproval: (approval: Approval, approved: boolean) => void | Promise<void>;
};

export function ApprovalPanel({ approvals, onResolveApproval }: ApprovalPanelProps) {
  return (
    <section className="detail-section approval-panel">
      <div className="section-heading"><ShieldAlert size={16} /> 待审批</div>
      {approvals.length === 0 && <p className="empty-copy">当前没有待审批操作</p>}
      {approvals.map((approval) => (
        <div className="approval-item" key={approval.id}>
          <strong>{approval.toolName}</strong>
          <pre>{JSON.stringify(approval.input, null, 2)}</pre>
          <div className="approval-actions">
            <button className="icon-button approve" title="允许操作" onClick={() => void onResolveApproval(approval, true)}><Check size={16} /></button>
            <button className="icon-button deny" title="拒绝操作" onClick={() => void onResolveApproval(approval, false)}><X size={16} /></button>
          </div>
        </div>
      ))}
    </section>
  );
}
