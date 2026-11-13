# Facebook Tool

Tool theo dõi bài Facebook mới và thực hiện Like, Share, Comment theo cấu hình. Giao diện web chỉ mở trên máy tại `127.0.0.1`; SQLite lưu cấu hình, lịch sử chống trùng và kết quả từng thao tác.

Điểm chính:

- Lấy 3 bài hiện có làm mốc; theo dõi bài mới từ các lượt đọc tiếp theo.
- Ba thao tác chạy song song trên tab nền, giữ nguyên cửa sổ đang thu nhỏ và ứng dụng bạn đang dùng.
- Chỉnh bình luận luân phiên, lời chia sẻ, hashtag, nguồn và khoảng chờ trên giao diện.
- Lưu công việc trước khi gửi; kết quả chưa rõ cần đối soát, không tự gửi lại.

## Cài đặt trên máy mới

Yêu cầu: **Windows, Node.js 24.x, Git**, Chrome hoặc Edge đã cài. Không cần cài thêm browser của Playwright; project dùng `playwright-core` với trình duyệt có sẵn.

Sửa `sources.local.json` bằng nguồn của bạn:

- `test-profile`: profile dùng thử nghiệm, URL dạng `https://www.facebook.com/profile.php?id=ID`.
- `page`: Page cần theo dõi, dùng URL chính tắc và ID Facebook dạng số của đúng Page.
- `name`: tên hiển thị trong danh sách nguồn; `sourceId`: ID dạng chuỗi; `url`: địa chỉ nguồn.

File mẫu chỉ chứa ID và địa chỉ minh họa. Thay thông tin ở mục bạn sử dụng, rồi chọn mục đó trên UI. Không dùng ID bài đăng thay cho ID nguồn. Khởi động lại tool sau khi sửa file nguồn.

`sources.local.json` được Git bỏ qua để giữ nguồn theo dõi riêng trên từng máy. Không sửa file mẫu thành nguồn cá nhân rồi commit lên public.

## Chạy tool

Mở `Start-Tool.cmd`, hoặc chạy:

```powershell
npm.cmd start
```

1. Trong cửa sổ được mở, bấm **Mở Facebook / Đăng nhập** và đăng nhập tài khoản cá nhân dùng tương tác.
2. Chọn nguồn, chế độ, nội dung và từng thao tác cần bật. Bấm **Lưu cấu hình**; nút **Lấy mốc/Bắt đầu** cũng lưu các thay đổi trước khi chạy.
3. Bấm **Lấy mốc 3 bài** để kiểm tra nguồn. Bấm **Bắt đầu** để lấy mốc mới và theo dõi liên tục.
4. Có thể thu nhỏ trình duyệt và làm việc khác. Giữ tiến trình chạy, máy có mạng và không ngủ.
5. **Dừng ngay** ngăn phần chưa gửi; **Đóng tool** đóng ứng dụng và trình duyệt riêng.

Mỗi lần khởi động có thể dùng cổng khác. Dùng địa chỉ/cửa sổ mới được tool mở; địa chỉ hiện tại cũng nằm trong `data/runtime.json`.

Mỗi lượt yêu cầu 3 bài trong luồng chính đã xác minh. Nếu có dấu hiệu ghim/nổi bật hoặc thứ tự không theo giờ đăng, kiểm tra mở rộng tối đa 5 bài bằng cursor thực tế, không quá 2 yêu cầu/lượt. UI vẫn hiện 3 bài theo giờ đăng trong tập đã đọc; mọi ID đã xác minh đều tham gia chống trùng/nhận bài. Bài cũ được đưa lên lại không thành bài mới vì đổi vị trí. Thiếu bằng chứng giữ danh sách hợp lệ trước đó; không bảo đảm Facebook luôn trả các bài mới nhất.

## Chế độ và kết quả

| Chế độ | Hành vi |
| --- | --- |
| Chạy thử | Chỉ ghi nhận thao tác dự kiến; mặc định khi cài mới. |
| Test | Gửi các thao tác đã bật; Share đặt Chỉ mình tôi. |
| Thực tế | Gửi các thao tác đã bật; Share đặt Công khai, có xác nhận khi bật. |

Like và Comment nằm trên bài gốc nên quyền xem phụ thuộc bài đó. **Thử trên bài có sẵn** chỉ dành cho nguồn thử nghiệm trong chế độ Test; không dùng lượt thử này để đo tốc độ phát hiện bài mới.

- **Thành công:** không gửi lại.
- **Lỗi trước khi gửi/Đã dừng:** có thể tiếp tục phần chưa gửi khi đúng tài khoản, nguồn và chế độ.
- **Chưa rõ kết quả:** bấm **Đối soát với Facebook** hoặc kiểm tra thủ công trước khi xác nhận trạng thái và thử lại.

Comment hỗ trợ phản hồi `feedback_comment_edge` và chỉ xác nhận nhanh khi mã phản hồi được gắn với đúng tài khoản, nội dung và mã bài đích của yêu cầu. Share ưu tiên bằng chứng của bài vừa tạo trong phản hồi hoặc thẻ bài đã hiển thị; không lấy quyền riêng tư từ hộp soạn hay bài gốc đính kèm. Thiếu hoặc mâu thuẫn bằng chứng vẫn đọc lại kết quả, không tự gửi lại.

Các tab thao tác và đọc lại giảm ảnh/video nội dung, giữ cache script/CSS/icon và chờ đúng dữ liệu/nút cần dùng. Bộ lọc dùng CDP; không dùng `page.route` để chặn media vì routing tắt HTTP cache. Nếu trang không sẵn sàng khi lọc, tool thử lại không lọc trước khi thao tác. Bộ đọc nguồn không đổi. Chạy `node scripts/benchmark-loading.ts` để so sánh bốn phương án trên HTTP cục bộ; báo cáo nằm trong `data/loading-local-benchmark.json`, không phải cam kết tốc độ Facebook thật.

Comment cần đọc lại sẽ chờ đúng bằng chứng tối đa 6 giây, kết thúc sớm khi tìm thấy; không ngủ cố định 1,5 giây. Thiếu hoặc mơ hồ bằng chứng vẫn để chưa xác nhận và không gửi lại.

## Đọc số đo thời gian

Bảng lấy **giờ đăng Facebook** làm mốc cho phát hiện và **Like / Share / Comment đã gửi**. Cột **Gửi xong tất cả** lấy mốc gửi cuối của các thao tác bật. Mốc gửi được ghi khi trình duyệt cho phép yêu cầu thao tác ra mạng, không dùng lúc bắt đầu bấm nút hoặc lúc xác nhận thành công. Đã gửi không có nghĩa là Facebook đã xử lý thành công.

Tool vẫn xác minh kết quả, quyền riêng tư và chống gửi trùng như trước. Trạng thái thành công/chưa rõ kết quả hiển thị riêng; thời gian dừng tại mốc gửi, không đo hoặc cộng thời gian chờ phản hồi, xác minh và đọc lại. Các bước trước gửi như tải bài, tìm nút, soạn nội dung vẫn được đo để tối ưu. Số đo cập nhật trong RAM và lưu cùng kết quả, không thêm request hoặc ghi đĩa tại mốc gửi.

Lượt cũ có bước submit hoàn tất dùng mốc kết thúc thao tác gửi và được ghi rõ là dữ liệu cũ; đây chưa phải mốc phát yêu cầu mạng. Thiếu mốc hoặc xác nhận thủ công/đối soát thì để trống. Bài thử có sẵn tính từ lúc bấm thử, không đo phát hiện bài mới.

Giờ máy được hiệu chỉnh theo phản hồi Facebook; các khoảng xử lý dùng đồng hồ đơn điệu. Cấu hình 2 giây là khoảng chờ sau khi lượt đọc trước kết thúc, nên chu kỳ thực tế còn cộng thời gian đọc.

Chẩn đoán phát hiện chậm: tool giữ **60 lượt quét gần nhất trong RAM**, gồm giờ bắt đầu/kết thúc, thời điểm gửi/nhận phản hồi, ID và giờ đăng bài, kết quả xác minh và lý do nhận/bỏ qua. Bài có trong phản hồi nhưng bị từ chối được phân biệt với bài chưa có trong tập đã đọc. Mỗi lượt vẫn dùng đúng yêu cầu đọc hiện tại, không thêm tải trang hay yêu cầu mạng.

Khi nhận bài mới, tool giữ bản chụp lịch sử và lưu vào SQLite **sau khi các nhánh thao tác kết thúc**; lỗi đọc được lưu khi không có thao tác đang chạy, và khi dừng sẽ lưu lịch sử gần nhất. Tối đa 80 bản chụp; các lượt bình thường không ghi thêm chẩn đoán xuống đĩa. Khởi động phiên mới xóa vòng RAM, các bản đã lưu vẫn còn. Nếu tiến trình bị đóng đột ngột trước lúc lưu, bản đang chờ có thể mất. Dữ liệu chẩn đoán không chứa cookie, token, cursor hay phản hồi thô; không đưa lên GitHub.

Xuất lịch sử bằng `node scripts/export-scan-history.mjs`; kết quả nằm trong `data/scan-history-*.json`. Khi tool tắt, lệnh đọc các bản chụp đã lưu bằng SQLite chỉ đọc. API cục bộ `/api/scan-history` dùng cùng khóa xác thực với bảng điều khiển và không được tải kèm mỗi lần UI cập nhật trạng thái.

## Lịch sử trên dashboard

**Kết quả tương tác** và **Thời gian từng bài** hiển thị tối đa 20 bài gần nhất, 5 bài mỗi trang. Tool dọn chi tiết các công việc cũ khỏi SQLite và giữ dấu chống gửi trùng. Các công việc đang chạy hoặc đang chờ trong hàng đợi được giữ đến khi xử lý xong. Bản chụp quét gắn với công việc được dọn cùng công việc.

**Nhật ký** hiển thị tối đa 50 dòng gần nhất, tải thêm 10 dòng mỗi lần cuộn xuống. Nhật ký được lưu 30 ngày. Dashboard cập nhật dữ liệu thay đổi và dựng phần hiển thị chi tiết thời gian khi mở.

## Dữ liệu riêng và chuyển máy

Không đưa `data/`, `sources.local.json`, cookie, hồ sơ trình duyệt hoặc log lên GitHub. `.gitignore` đã loại các mục này.

Clone chỉ chuyển mã nguồn. Trên máy mới cần cấu hình nguồn và đăng nhập lại; lịch sử trên máy cũ không tự đồng bộ. Không chạy đồng thời hai bản cùng tài khoản/nguồn. Khi Bắt đầu, 3 bài có sẵn được bỏ qua; tool không quét bù bài trong lúc tắt.

## Phát triển và kiểm tra

```powershell
npm.cmd run check
npm.cmd test
npm.cmd run test:reader
```

Các kiểm thử dùng dữ liệu giả lập, không đăng lên Facebook thật. Kiểm tra giữ focus/cửa sổ trên Windows được bật riêng bằng `TOOL_FOCUS_TEST=1`; cần desktop tương tác và mở cửa sổ trình duyệt thử nghiệm.

Mã chính: `src/engine.ts` điều phối, `src/store.ts` lưu SQLite, `src/facebook/` điều khiển trình duyệt/tương tác, `src/facebook/feed/` đọc và xác minh danh sách, `public/` là UI. Yêu cầu nghiệp vụ gọn nằm trong [BRD](BRD-Facebook-Automation.md).

Tool tự động hóa trình duyệt, không phải ứng dụng chính thức của Meta. Thay đổi giao diện Facebook có thể cần cập nhật bộ đọc/thao tác; khi không xác minh được dữ liệu, tool dừng phần tương ứng. Chưa có cam kết chạy ổn định 24/7 hoặc hỗ trợ mọi dạng Reels/Stories/live.
