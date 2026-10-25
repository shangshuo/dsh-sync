# Cloud backup targets for dsh config sync

*Scope: a few MB, low thousands of small files (plugins, JSON/YAML, skills, MCP configs). List prices, Oct 2026; USD unless noted; tax/egress excluded; re-verify before release.*

**Workload note.** Storage costs cents; round-trips, latency and throttling dominate. Thousands of tiny files mean thousands of PUT/LIST calls per sync. Pack each snapshot into a few content-addressed objects (tar+zstd or chunked packs) plus a manifest; upload only changed packs. Then request pricing stops mattering and weak APIs become tolerable.

## 1. S3-compatible object storage

All use static keys + SigV4 (or a compatible variant), no browser OAuth — the key property for a desktop plugin.

| Provider | S3 compat | Regions (US/EU/JP/CN) | Free tier | ≈$/GB-mo | ≈$/10k req (PUT/GET) | Auth quirk | Src |
|---|---|---|---|---|---|---|---|
| AWS S3 | Reference | US/EU/JP/CN¹ | legacy 5 GB/12 mo | 0.023 | 0.05 / 0.004 | IAM SigV4; CN is a separate partition | 1,2 |
| Cloudflare R2 | High | Global; EU jurisdiction; no JP/CN | 10 GB | 0.015 | 0.045 / 0.0036 | R2 token as AK/SK; no IAM/ACLs | 3,4 |
| Backblaze B2 | High | US/EU | 10 GB | 0.006 | 0.004 (Class B) | App key, often bucket-scoped | 5,6 |
| Wasabi | High | US/EU/JP | — | 0.007 | 0 (no request fees) | 1 TB + 90-day minimum | 7,8 |
| MinIO | High | Self-hosted | — | 0 | 0 | You run it; own AK/SK | 9 |
| Alibaba OSS | Subset² | CN/US/EU/JP | trial | ~0.017 | ~0.0015 | AK/SK; real-name; native signing | 10,11 |
| Tencent COS | Good | CN/US/EU/JP | trial | ~0.016 | ~0.0015 | SecretId/Key; APPID in bucket name | 12,13 |
| Huawei OBS | Good | CN/EU/APAC; no US | trial | ~0.014 | low | AK/SK; enterprise real-name | 14,15 |
| iDrive e2 (= IDrive) | High | US/EU | 10 GB | ~0.008 (≈$99/TB/yr) | low | AK/SK; annual plans | 16 |
| Scaleway | High | EU only | 75 GB | ~0.017 (€0.0146) | ~€0.01 | AK/SK | 17 |
| OVHcloud | High | EU/CA/AU/SG | — | ~0.014 (€0.0119) | low | AK/SK | 18 |
| Hetzner | High | DE/FI | — | ~0.006 (€4.99/1 TB) | included | AK/SK | 19 |
| Oracle OCI | Subset | US/EU/JP | 10 GB | 0.0255 | low | Customer Secret Key (not IAM) | 20,21 |
| DigitalOcean Spaces | High | US/EU/SG/AU/IN/CA | — | 0.02³ | 0 | AK/SK | 22 |
| Akamai/Linode | High | US/EU/JP/SG/AU | — | 0.02³ | 0 | AK/SK | 23 |

¹ AWS China needs a China account and separate partition. ² Documented S3 subset with behavioural differences. ³ $5/mo includes 250 GB + 1 TB egress.

**Read-across.** Plain SigV4 + AK/SK: AWS, R2, B2, Wasabi, MinIO, iDrive e2, Scaleway, OVHcloud, Hetzner, DigitalOcean, Akamai. Oracle uses a separate Customer Secret Key; Alibaba, Tencent and Huawei accept AK/SK but expose S3 subsets. Japan: AWS, Wasabi, Alibaba, Tencent, Oracle, Akamai. China: Alibaba, Tencent, Huawei, AWS China. Free egress: R2, B2 (3× stored), Wasabi (up to stored). At MB scale minimums dominate: Wasabi and Hetzner bill 1 TB (~$5–7/mo), iDrive is annual; R2/B2/Scaleway free tiers cover this workload.

## 2. China-market consumer drives

| Service | Official API | Auth | Limits | WebDAV | Verdict | Src |
|---|---|---|---|---|---|---|
| Baidu Netdisk | Yes (open platform) | OAuth 2.0 + app review | ~4 GB/file free; higher paid; QPS caps; download throttling | No | Hard; app review + CN ID | 24 |
| Aliyun Drive | Yes (open platform, review) | OAuth 2.0 | Tier caps, QPS | No | Hard; partner-ish | 25 |
| Tencent Weiyun | No consumer API | — | — | No | Unusable (WeCom 微盘 only) | 52 |
| 123云盘 | Yes (open platform) | Auth code → token | Tier caps, QPS | No | Moderate | 26 |
| Nutstore (坚果云) | WebDAV (official) | App password / Basic | ~1 GB free + monthly traffic caps | Yes, dav.jianguoyun.com | Easiest; ship first | 27 |
| Quark (夸克) | No public dev API; first-party AI skill only | Unofficial tokens | — | No | Unusable | 51 |

Only Nutstore is a normal standards endpoint. Baidu/Aliyun/123 need a Chinese developer account and review, and their terms constrain third-party clients — treat them as bridge or v2.

## 3. US/EU/JP consumer and business drives

| Service | API | OAuth app registration | WebDAV | Src |
|---|---|---|---|---|
| Google Drive | REST v3 | Yes (GCP project; `drive.file`) | No | 28,29,30 |
| Dropbox | REST v2 | Yes (scoped app, PKCE) | No | 31 |
| OneDrive/SharePoint | Microsoft Graph | Yes (Entra app) | No | 32 |
| Box | REST | Yes | No | 33 |
| pCloud | REST | Yes | Yes (webdav.pcloud.com) | 34,35 |
| Sync.com | None public | — | No | — |
| Proton Drive | SDK only | — | No | 36 |
| iCloud Drive | None (CloudKit ≠ Drive) | — | No | — |
| Yandex Disk | REST | Yes | Yes (app passwords) | 37,38 |
| Koofr | REST | Yes | Yes | 39 |
| Nextcloud | OCS/REST | n/a (self-host) | Yes | 40 |
| Seafile | REST | n/a (self-host) | Yes (seafdav) | 41 |
| Jottacloud | REST/token | Token | No documented | 42 |
| kDrive (Infomaniak) | REST | Yes | Yes (WebDAV) | 43,55 |
| MEGA | SDK only | No (email/pw + MFA) | No | 44 |
| Tresorit | Business API only | — | No | 45 |
| Filen | REST + API key | API key | No | 46 |

Desktop OAuth means loopback redirect (RFC 8252) + PKCE [53]; each provider needs a developer account, consent screen and sometimes review. `drive.file` is non-sensitive and sees only app-created files.

## 4. The rclone bridge

`rclone serve webdav remote:path --addr 127.0.0.1:8080 --user dsh --pass <secret>` or `rclone serve s3 remote:path --auth-key ACCESS,SECRET --addr 127.0.0.1:8081` exposes any of rclone's 70+ backends (Google Drive, OneDrive, Dropbox, MEGA, pCloud, Yandex, Koofr, S3, WebDAV) as one local endpoint [47,48,49].

Correction: upstream rclone has no Baidu, Aliyun Drive, Quark, 123pan or Weiyun backend [49]; AList/OpenList cover those and serve WebDAV (e.g. Baidu [50]). "Any cloud" is therefore two bridges: rclone for Western/S3, OpenList for Chinese drives.

Caveats: the user still authenticates in rclone and tokens live in `rclone.conf` (a second secret store); it is a separate process to install/bundle (~20–50 MB) and supervise; `serve s3` is experimental/limited while `serve webdav` is mature; bind loopback + auth, and keep it patched (`serve s3` has had a path-traversal advisory [54]); provider quirks surface as opaque errors; keep snapshot/conflict semantics in dsh.

Verdict: a good power-user escape hatch, not the default v1 path.

## 5. Recommendation (ranked)

1. **Generic S3 (SigV4)** — one adapter, ~15 providers, static keys; US/EU/JP via AWS/Wasabi/Akamai, China via Alibaba/Tencent subsets (test). R2/B2/Scaleway free tiers fit a few MB.
2. **Generic WebDAV** — Nutstore, Nextcloud/Seafile, pCloud, Yandex, Koofr, kDrive; one HTTP client, app passwords, no OAuth (MKCOL, MOVE, PROPFIND, temp+rename, 429/507 backoff). Only realistic China consumer path.
3. **Google Drive** — broadest US/EU/JP reach; `drive.file` avoids sensitive-scope review; 15 GB free.
4. **OneDrive (Graph)** — Windows-native, Microsoft 365; free app registration; 5 GB free.
5. **Alibaba Cloud OSS** — China object storage; AK/SK, no OAuth, Chinese account. Tencent COS equivalent.
6. **Dropbox** — optional; cheap OAuth, strong US/EU, no China/Japan edge.

Skip for v1: Baidu/Aliyun/Quark native, Sync/Proton/iCloud/Tresorit, MEGA (SDK-only). Offer the rclone bridge as "any other cloud".

**Privacy.** Config backups contain API keys and MCP tokens. Encrypt paths and contents before upload (XChaCha20-Poly1305/Argon2id or age) and upload ciphertext + manifest. S3 SSE and provider scanning then matter less; count/size/timing still leak. Zero-knowledge hosts (Filen, Proton, MEGA, Sync, Tresorit) are no shortcut — their APIs are the weakest here.

**Uncertainties.** China drive APIs/terms change often; several are partner-only. S3 compatibility ranges from full to documented subset — test PUT/GET/LIST/multipart per endpoint. Prices are list, exclude tax/egress, vary by region; treat as order-of-magnitude. iDrive e2 = IDrive. Absence claims mean no public developer docs found as of Oct 2026.

## Sources

1. https://aws.amazon.com/s3/pricing/
2. https://aws.amazon.com/free/
3. https://developers.cloudflare.com/r2/pricing/
4. https://developers.cloudflare.com/r2/api/s3/api/
5. https://www.backblaze.com/cloud-storage/pricing
6. https://www.backblaze.com/docs/cloud-storage-s3-compatible-api
7. https://wasabi.com/pricing
8. https://docs.wasabi.com/docs/how-does-wasabis-minimum-storage-duration-policy-work
9. https://min.io/docs/minio/linux/index.html
10. https://www.alibabacloud.com/help/en/oss/developer-reference/compatibility-with-amazon-s3
11. https://www.alibabacloud.com/product/oss/pricing
12. https://cloud.tencent.com/document/product/436/41284
13. https://www.tencentcloud.com/pricing/cos
14. https://www.huaweicloud.com/intl/en-us/product/obs.html
15. https://rclone.org/s3/
16. https://www.idrive.com/s3-storage-e2/
17. https://www.scaleway.com/en/pricing/storage/
18. https://www.ovhcloud.com/en/public-cloud/object-storage/
19. https://www.hetzner.com/storage/object-storage/
20. https://docs.oracle.com/en-us/iaas/Content/Object/Tasks/s3compatibleapi.htm
21. https://docs.oracle.com/en-us/iaas/Content/Identity/access/working-with-customer-secret-keys.htm
22. https://www.digitalocean.com/pricing/spaces-object-storage
23. https://www.linode.com/products/object-storage/
24. https://pan.baidu.com/union/doc/
25. https://www.yuque.com/aliyundrive/zpfszx/efabcs
26. https://123yunpan.yuque.com/org-wiki-123yunpan-muaork/cr6ced/gammzlhe6k4qtwd9
27. https://help.jianguoyun.com/?p=3168
28. https://developers.google.com/workspace/drive/api/guides/about-sdk
29. https://developers.google.com/workspace/drive/api/guides/limits
30. https://developers.google.com/workspace/drive/api/guides/api-specific-auth
31. https://www.dropbox.com/developers/documentation/http/documentation
32. https://learn.microsoft.com/en-us/graph/api/resources/onedrive
33. https://developer.box.com/
34. https://docs.pcloud.com/
35. https://help.pcloud.com/article/connect-to-pcloud-using-webdav-and-rsync
36. https://github.com/ProtonDriveApps/sdk
37. https://yandex.com/dev/disk-api/doc/en/
38. https://www.yandex.ru/support/yandex-360/customers/disk/web/ru/webdav
39. https://koofr.eu/help/koofr_with_webdav/how-do-i-connect-a-service-to-koofr-through-webdav/
40. https://docs.nextcloud.com/server/latest/user_manual/en/files/access_webdav.html
41. https://manual.seafile.com/latest/extension/webdav/
42. https://rclone.org/jottacloud/
43. https://developer.infomaniak.com/docs/api
44. https://github.com/meganz/sdk
45. https://support.tresorit.com/hc/en-us/articles/33971802915858-Tresorit-API
46. https://docs.filen.io/docs/api/endpoints-overview/
47. https://rclone.org/commands/rclone_serve_s3/
48. https://rclone.org/commands/rclone_serve_webdav/
49. https://rclone.org/overview/
50. https://doc.oplist.org/guide/drivers/baidu
51. https://github.com/quark-clouddrive/quarkclouddrive_offical
52. https://developer.work.weixin.qq.com/document/path/97918
53. https://datatracker.ietf.org/doc/html/rfc8252
54. https://github.com/rclone/rclone/security/advisories/GHSA-8v25-v8p6-qf7v
55. https://www.infomaniak.com/en/support/faq/2409/connect-to-kdrive-via-webdav
