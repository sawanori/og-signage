/** Administrator 専用画面を Staff が開いたときの案内（計画 6 節の権限表）。 */
import { ShieldAlert } from "lucide-react";
import styles from "./settings.module.css";

export function ForbiddenNotice() {
  return (
    <div className={styles.forbidden} role="alert">
      <ShieldAlert className={styles.forbiddenIcon} size={40} strokeWidth={1.6} aria-hidden />
      <p className={styles.forbiddenTitle}>この画面は管理者のみ利用できます</p>
    </div>
  );
}
