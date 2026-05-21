// Circular user avatar. Renders the uploaded image when has_avatar=true,
// otherwise initials on a deterministic background colour.

import { useState } from "react";

import { avatarURL } from "../lib/api";
import { avatarColorOf, initialsOf } from "../lib/users";
import type { UserInfo } from "../types/proto";

export function Avatar({
  user,
  serverUrl,
  token,
  size = 28,
  className,
  title,
}: {
  user: UserInfo;
  serverUrl: string;
  token: string;
  size?: number;
  className?: string;
  title?: string;
}) {
  const [failed, setFailed] = useState(false);
  const url = !failed ? avatarURL(serverUrl, token, user) : null;
  const initials = initialsOf(user);
  const bg = avatarColorOf(user);
  const style: React.CSSProperties = {
    width: size,
    height: size,
    borderRadius: "50%",
    fontSize: Math.max(10, Math.round(size * 0.42)),
    background: url ? "transparent" : bg,
  };
  return (
    <span
      className={`avatar ${className ?? ""}`}
      style={style}
      title={title}
      aria-label={initials}
    >
      {url ? (
        <img
          src={url}
          alt=""
          width={size}
          height={size}
          onError={() => setFailed(true)}
          draggable={false}
        />
      ) : (
        <span aria-hidden="true">{initials}</span>
      )}
    </span>
  );
}
