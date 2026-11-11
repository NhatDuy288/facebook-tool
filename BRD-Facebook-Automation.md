# BRD — Facebook Laptop Tool

Tài liệu mô tả yêu cầu hiện hành; cách cài đặt và sử dụng xem [README](README.md). Không lưu lịch sử trao đổi, nguồn cá nhân, tài khoản hoặc bằng chứng phiên chạy trong tài liệu public.

## 1. Mục tiêu và phạm vi

Ứng dụng một người vận hành trên Windows: theo dõi một nguồn Facebook bằng một tài khoản cá nhân, tự Like/Share/Comment bài mới theo cấu hình. Ưu tiên đúng nguồn/bài/danh tính/nội dung, chống trùng, quan sát được tốc độ và dễ dừng.

- Node.js 24, TypeScript, Playwright dùng Chrome/Edge có sẵn; UI chỉ nghe trên loopback.
- Nguồn thử nghiệm và nguồn Page cấu hình riêng tại `sources.local.json`; không đưa thông tin nguồn thật vào mã public.
- Chỉ theo dõi khi người dùng bấm Bắt đầu. Không lịch giờ hành chính, quét bù khoảng nghỉ, nhiều tài khoản hay tạo bình luận bằng AI.
- Máy phải bật, có mạng, không ngủ. Không tự sửa cài đặt nguồn điện hoặc chạy cùng Windows.

## 2. Cấu hình và điều khiển

- UI chỉnh nguồn, chế độ, khoảng chờ 1–300 giây, bật/tắt từng thao tác, bình luận, lời chia sẻ, hashtag và giữ phiên.
- Bình luận dùng từng dòng, tuần tự và quay vòng. Nội dung kế tiếp chuẩn bị sẵn; khi nhận bài, chụp nội dung vào công việc để thay đổi sau đó không làm lệch bài đang xử lý.
- Chạy thử chỉ ghi nhận. Test chia sẻ Chỉ mình tôi. Thực tế chia sẻ Công khai và phải được người vận hành xác nhận khi bật. Like/Comment theo quyền xem bài gốc.
- Lấy mốc/Bắt đầu áp dụng cấu hình đang chọn trước khi chạy; không được âm thầm dùng nguồn cũ.
- Dừng ngay chặn thao tác chưa gửi. Đóng tool đóng các tiến trình/trình duyệt riêng và giữ dữ liệu đã lưu.

## 3. Phát hiện bài

1. Mỗi lần Bắt đầu xác minh tài khoản và nguồn, đọc hai lượt hợp lệ với cửa sổ chính 3 bài để tạo mốc mới; bỏ qua mọi ID đã xác minh trong cả hai lượt, kể cả phần mở rộng.
2. Mặc định chờ 2 giây sau khi lượt trước kết thúc. Chu kỳ thực gồm chờ và đọc; không cam kết độ trễ tối đa.
3. Chỉ nhận bài đúng nguồn, có ID/thời gian hợp lệ, không trước mốc giờ Facebook và chưa có trong lịch sử. Không lấy ID lớn nhất hay thứ tự hiển thị làm bằng chứng duy nhất.
4. Chỉ dùng yêu cầu đọc thực tế đã quan sát/xác minh. Yêu cầu đầu 3 bài; dấu hiệu ghim/nổi bật hoặc đảo thứ tự thì mở rộng tối đa 5 bằng cursor cùng chuỗi. Không quá hai batch/lượt; không phân trang quét bù. Chỉ coi trường ghim/nổi bật là dấu hiệu kiểm tra thêm, không tự suy ra bài mới.
5. UI hiện 3 bài theo giờ đăng trong tập đã đọc; phát hiện/chống trùng dùng mọi bài đã xác minh. Không cam kết cửa sổ là các bài mới nhất của toàn feed. Phản hồi lỗi/thiếu, kể cả mở rộng chưa đủ, giữ cửa sổ hợp lệ cuối. Ba lỗi đọc liên tiếp dừng phiên; lỗi đăng nhập, xác minh hoặc đổi danh tính dừng để kiểm tra.

## 4. Thao tác và chống trùng

- Lưu công việc/nội dung và trạng thái ý định gửi vào SQLite trước khi gửi. Ba nhánh chạy song song trên tab riêng, kết quả độc lập.
- Xác minh đúng bài gốc và tài khoản. Share nguyên bản về trang cá nhân, kiểm tra đối tượng xem và bài đích trước/sau gửi; không tự thay đổi cảm xúc đã tồn tại.
- Các tab thao tác/đọc lại chỉ chặn CDN ảnh/video nội dung qua CDP, giữ cache script/CSS/icon. Chờ dữ liệu đúng bài/tài khoản và nút cần dùng thay vì toàn bộ DOMContentLoaded; vẫn xác minh lại trước gửi. Nếu lọc media làm trang không sẵn sàng, tải lại không lọc trước khi thao tác. Không dùng route để lọc tài nguyên; route kiểm tra gửi chỉ tồn tại lúc gửi.
- Comment đọc lại chờ bằng chứng khớp nội dung/quyền sửa và liên kết bình luận, tối đa 6 giây thay vì ngủ cố định. Không có/mơ hồ bằng chứng thì chưa xác nhận, không gửi lại.
- Comment xác nhận nhanh từ phản hồi dạng đơn/mảng khi khớp tài khoản, nội dung và bài đích. Share chỉ bỏ tải lại khi đủ bằng chứng bài mới/bài gốc/quyền riêng tư từ phản hồi hoặc thẻ bài đã đăng; thiếu/mâu thuẫn vẫn đọc lại.
- Chỉ đánh dấu thành công khi có bằng chứng kết quả. Kết quả chưa rõ không tự gửi lại; đối soát chỉ đọc, hoặc người vận hành xác nhận thủ công.
- Khôi phục phân biệt chưa gửi, đang chuẩn bị và đã bắt đầu gửi. Thành công giữ nguyên; sau gián đoạn, phần có thể đã gửi chuyển trạng thái cần đối soát.
- Lịch sử chống trùng tồn tại qua khởi động lại và đổi cửa sổ 3 bài. Không xóa theo kỳ nhật ký; giao dịch lưu phải nguyên tử.
- Chỉ một tiến trình được dùng cùng thư mục dữ liệu. Không điều khiển cùng tài khoản từ hai máy đồng thời.

## 5. Thời gian và chạy nền

- Ghi thời điểm xác minh đầu tiên của mỗi bài trong batch chứa nó, không lấy lúc tạo công việc làm thời gian phát hiện.
- Độ trễ từ đăng đến phát hiện dùng giờ phản hồi Facebook và thời điểm gửi/nhận để hiệu chỉnh lệch đồng hồ, kèm sai số.
- Chờ, xử lý và khoảng từ phát hiện tới xác nhận đo bằng đồng hồ đơn điệu. Nếu giờ máy bị chỉnh trong lượt đọc, bỏ phép hiệu chỉnh của lượt đó.
- Tổng từ đăng đến hoàn thành là mốc lâu nhất của các thao tác bật, chỉ khi tất cả đã thành công và có phép đo. Thao tác tắt không tham gia tổng.
- Chi tiết mỗi nhánh đo các bước tải/xác minh bài, tìm nút, soạn/gửi, phản hồi và đọc lại; hiển thị thời lượng từng bước, mốc cộng dồn và bước lâu nhất. Phân biệt phản hồi sơ bộ, Facebook xác nhận và tool xác minh xong. Đo trong RAM, lưu kết quả; không thêm chờ/request. Lượt cũ thiếu trace để trống.
- Bài thử có sẵn không phải mẫu đo phát hiện. Dữ liệu cũ thiếu hiệu chỉnh, đối soát/xác nhận thủ công hoặc đã thích từ trước không được gán mốc hoàn tất suy đoán.
- UI hiển thị phát hiện, từng thao tác, tổng; chi tiết lượt đọc, chờ và xử lý. Từ 60 giây hiển thị phút/giây.
- Tự động chạy ở nền: không kích hoạt cửa sổ hoặc khôi phục cửa sổ thu nhỏ khi mở/đóng tab, đọc, tương tác hay đối soát. Chỉ hiện chủ động lúc khởi động/mở đăng nhập. Không tạo được tab nền thì báo lỗi, không chuyển sang tab giành focus.

## 6. Dữ liệu và nghiệm thu

- Chỉ lưu cục bộ: cấu hình nguồn, SQLite, hồ sơ trình duyệt/phiên đăng nhập và runtime. Không công khai cookie, token, mật khẩu, hồ sơ, dữ liệu bài/tài khoản hoặc log phiên chạy.
- Repository chỉ gồm mã nguồn cần chạy, dependency lock, launcher, cấu hình mẫu, tài liệu và kiểm thử có dữ liệu giả lập; không phụ thuộc tài liệu nghiên cứu riêng.
- Đạt khi clone sạch cài/chạy được theo README; nguồn chỉnh được không sửa mã; kiểm tra TypeScript và các bộ test đạt; không gửi trùng/nhầm nguồn; Dừng/khôi phục/đối soát an toàn; số đo chịu được lệch giờ; test Windows xác nhận giữ focus và trạng thái thu nhỏ.
- Test giả lập không thay thế nghiệm thu Facebook thật. Chưa cam kết 24/7, độ trễ cố định, mọi dạng bài hoặc xuất bản công khai cho mọi tài khoản.

- Mở Share nhận diện đồng thời menu và hộp soạn gắn với Bảng feed; chỉ chọn mục mở hộp soạn, không bấm chia sẻ ngay. Tách thời gian tìm nút/bấm/chờ/menu/editor và mốc request/phản hồi; lưu nhãn bản thực thi trong trace. Thiếu hoặc mơ hồ vẫn dừng, giữ xác minh tài khoản/đích/quyền riêng tư và đọc lại như trước. Khi triển khai phải có checkpoint mã trước sửa và kiểm tra khả năng hoàn tác, giữ dữ liệu phiên chạy.
