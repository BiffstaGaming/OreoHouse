# Changelog

## [0.8.0](https://github.com/BiffstaGaming/OreoHouse/compare/v0.7.0...v0.8.0) (2026-05-21)


### Features

* **client:** native OS sub-windows per chat, with resize + per-conv geometry ([08204e7](https://github.com/BiffstaGaming/OreoHouse/commit/08204e72c3ce03cca09f6feed7442268b372d8d4))
* **client:** persist session across launches + hide page-level scrollbar ([20aaccc](https://github.com/BiffstaGaming/OreoHouse/commit/20aaccce63a984f3cd17bebed607034ab364b5aa))

## [0.7.0](https://github.com/BiffstaGaming/OreoHouse/compare/v0.6.0...v0.7.0) (2026-05-21)


### Features

* **api:** admin REST endpoints behind requireAdmin ([64ada81](https://github.com/BiffstaGaming/OreoHouse/commit/64ada81fed0273b70988eee3625b0cf5ce1d792e))
* **api:** embedded /admin/ web UI ([c766101](https://github.com/BiffstaGaming/OreoHouse/commit/c7661019b17636f8fdd8c2ee975ad6e0ef022510))
* **auth:** is_admin column + admin helpers ([0c529fa](https://github.com/BiffstaGaming/OreoHouse/commit/0c529fa168950004409d75d65e01ff63c2389767))
* **cli:** bootstrap first user to admin + promote/demote subcommands ([be1e893](https://github.com/BiffstaGaming/OreoHouse/commit/be1e893a007e456a444431c0db6103cfa3a8a283))

## [0.6.0](https://github.com/BiffstaGaming/OreoHouse/compare/v0.5.0...v0.6.0) (2026-05-21)


### Features

* **client:** contact-list primary view + floating chat windows ([193e1b9](https://github.com/BiffstaGaming/OreoHouse/commit/193e1b9bb1c8314b7fcc71ef01e2740cc35d24c6))
* **client:** message + nudge sounds with mute toggle ([d5e6d19](https://github.com/BiffstaGaming/OreoHouse/commit/d5e6d19d971790df3119230e46f8c266eead3f96))
* **client:** MSN-flavored visual polish ([338bf9a](https://github.com/BiffstaGaming/OreoHouse/commit/338bf9a22eb21910139a546feb18a8ba0989e79c))
* **client:** system tray + minimize-to-tray ([fbff211](https://github.com/BiffstaGaming/OreoHouse/commit/fbff2117b7ff4b4ca96d23f294bac9a60130fd6a))
* **client:** taskbar flash + unread-count window title ([0a8949d](https://github.com/BiffstaGaming/OreoHouse/commit/0a8949d3c87869f037f6f47aa3bccefcde4b1f69))
* **presence:** online / away / busy + custom status text ([bcdcdbf](https://github.com/BiffstaGaming/OreoHouse/commit/bcdcdbf849c49cc8fc6b5e257bd526ef2bca3f46))
* **ws:** nudges with shake animation ([035b863](https://github.com/BiffstaGaming/OreoHouse/commit/035b863b8d8311954ba28520e77f2dd9a402d0e3))
* **ws:** typing indicators ([9acff4f](https://github.com/BiffstaGaming/OreoHouse/commit/9acff4f1c99f4ec569654197c781ebbe2f4c386e))

## [0.5.0](https://github.com/BiffstaGaming/OreoHouse/compare/v0.4.1...v0.5.0) (2026-05-21)


### Features

* **api:** REST endpoints for groups, rooms, and members ([c51fd99](https://github.com/BiffstaGaming/OreoHouse/commit/c51fd99ba7fff97e60db17c6f0fe1009bcc95f17))
* **api:** REST upload + download for attachments ([91cbd5e](https://github.com/BiffstaGaming/OreoHouse/commit/91cbd5ece6a968fe316e4f54c55ddc4c476d7a25))
* **client:** file picker + inline image previews in the composer ([279287c](https://github.com/BiffstaGaming/OreoHouse/commit/279287c189f8297345e3411a12a2546b23b92d4e))
* **client:** groups, rooms, and member-aware chat UI ([813791c](https://github.com/BiffstaGaming/OreoHouse/commit/813791ceb26f1fd3b451803644f6617313d0ec70))
* **db:** attachments table + filesystem store ([440abaf](https://github.com/BiffstaGaming/OreoHouse/commit/440abafc58886a9caca6d7141b579ef370e2a2d2))
* **db:** groups + rooms in conversations service ([b772a3b](https://github.com/BiffstaGaming/OreoHouse/commit/b772a3b2ac4d6fe264fd1441d4806c0176d120c7))
* **ws:** attachments on messages — send, broadcast, history, replay ([6d6b81c](https://github.com/BiffstaGaming/OreoHouse/commit/6d6b81c0731a5ee195f8e483350a4f3fcf98f134))
* **ws:** conversation_added + conversation_members_changed events ([fc8873d](https://github.com/BiffstaGaming/OreoHouse/commit/fc8873d87e52bdfefff68cb33cb86e96b2587fb8))

## [0.4.1](https://github.com/BiffstaGaming/OreoHouse/compare/v0.4.0...v0.4.1) (2026-05-21)


### Bug Fixes

* **server:** allow cross-origin REST requests from Tauri client ([fecae1e](https://github.com/BiffstaGaming/OreoHouse/commit/fecae1edcfb73bf4d688ec657d896c35d12cc0eb))

## [0.4.0](https://github.com/BiffstaGaming/OreoHouse/compare/v0.3.0...v0.4.0) (2026-05-20)


### Features

* **api:** /api/conversations + /api/conversations/{id}/messages ([86e3daa](https://github.com/BiffstaGaming/OreoHouse/commit/86e3daacebecfabda5e7face845600d78d666eea))
* **client:** side-by-side presence + chat UI ([4cc94b4](https://github.com/BiffstaGaming/OreoHouse/commit/4cc94b44f3cbc640c3a1031165fd7bb27f791495))
* **db:** conversations schema + service ([5155050](https://github.com/BiffstaGaming/OreoHouse/commit/515505045a7db2997a2a9b96641d8f89a706f393))
* **db:** messages.Service — send, history, replay ([23ba034](https://github.com/BiffstaGaming/OreoHouse/commit/23ba034e0351a0fd5a52c281672c95f7c44be20b))
* **ws:** message send/receive over /ws + replay on reconnect ([e91a78f](https://github.com/BiffstaGaming/OreoHouse/commit/e91a78fe8d2300325da5080a5793a527f64f3d87))

## [0.3.0](https://github.com/BiffstaGaming/OreoHouse/compare/v0.2.0...v0.3.0) (2026-05-20)


### Features

* **client:** login form + live presence list ([ab400f6](https://github.com/BiffstaGaming/OreoHouse/commit/ab400f6a4ba2105c60cbe8aab414e94b32f37c54))
* **ws:** authenticated hub with online/offline presence ([196027b](https://github.com/BiffstaGaming/OreoHouse/commit/196027b3a00182ccf63e4261aba24f3160d0c8de))


### Bug Fixes

* **ci:** pass --repo to gh workflow run in release-please ([f724735](https://github.com/BiffstaGaming/OreoHouse/commit/f7247352574bd2b3b8ee92d03a3a7d685389b91f))

## [0.2.0](https://github.com/BiffstaGaming/OreoHouse/compare/v0.1.0...v0.2.0) (2026-05-20)


### Features

* **admin:** oreohouse user add + user list CLI ([4dc46ee](https://github.com/BiffstaGaming/OreoHouse/commit/4dc46eefddae542f9838b0ada27d964de4b9390b))
* **api:** POST /api/auth/login + /api/auth/logout ([d877eff](https://github.com/BiffstaGaming/OreoHouse/commit/d877eff179b5c93845c37306047007c82b81e2e0))
* **auth:** password hashing, session tokens, user/session DB ops ([3eefbd2](https://github.com/BiffstaGaming/OreoHouse/commit/3eefbd2e8ccff9e4fe427fde0ec5a67243c49d28))
* **db:** connection wrapper + migration runner with initial schema ([3a198e3](https://github.com/BiffstaGaming/OreoHouse/commit/3a198e3baf3cf415b4426fcd13e4e1dbc2adf4ab))


### Bug Fixes

* **ci:** chain downstream builds via workflow_dispatch ([c4093d5](https://github.com/BiffstaGaming/OreoHouse/commit/c4093d571171798fcbc016a059e620a7c630467d))

## 0.1.0 (2026-05-20)


### Features

* **client:** tauri+react hello-world that talks to /ws ([b2c0122](https://github.com/BiffstaGaming/OreoHouse/commit/b2c0122ed83f711379f42a23bc27622d6057f4a6))
* **server:** hello-world server with /health and echo /ws ([ee582e7](https://github.com/BiffstaGaming/OreoHouse/commit/ee582e71d0497ab8c64c895eaf1a07baaa0b9c8f))


### Miscellaneous Chores

* pin first release at 0.1.0 ([a05e4a0](https://github.com/BiffstaGaming/OreoHouse/commit/a05e4a00598fbe6a90957537df5acd2a5f1fed1e))
