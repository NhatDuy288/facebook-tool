const MESSAGES: Record<string, string> = {
  SOURCE_NOT_CONFIGURED: 'Nguồn này vẫn dùng dữ liệu mẫu. Chỉnh ID và URL trong sources.local.json rồi mở lại tool.',
  CONFIG_INVALID: 'Cấu hình chưa hợp lệ. Kiểm tra bình luận, hashtag và khoảng chờ 1–300 giây.',
  BUSY: 'Hãy dừng theo dõi và chờ các thao tác kết thúc trước khi thay nguồn hoặc chế độ.',
  LOGIN_REQUIRED: 'Cần đăng nhập tài khoản theo dõi trong tab Facebook.',
  LOGIN_OR_CHECKPOINT: 'Facebook yêu cầu đăng nhập hoặc xác minh. Đã dừng tương tác.',
  ACTOR_CHANGED: 'Danh tính Facebook đã thay đổi. Hãy kiểm tra tài khoản rồi khởi động phiên mới.',
  PERSONAL_ACCOUNT_REQUIRED: 'Hãy chuyển sang tài khoản cá nhân theo dõi, rồi thử lại.',
  SOURCE_PAGE_UNAVAILABLE: 'Tab nguồn đã đổi địa chỉ hoặc không truy cập được.',
  OBSERVED_QUERY_NOT_VERIFIED: 'Chưa thu được yêu cầu đọc danh sách hợp lệ từ trang nguồn. Kiểm tra Facebook rồi thử lại.',
  HEAD_QUERY_UNVERIFIED: 'Chưa xác minh được cấu trúc đọc danh sách. Không tiếp tục bằng dữ liệu đoán.',
  FRESH_PROTOCOL_UNAVAILABLE: 'Phiên đọc Facebook không còn hợp lệ. Mở Facebook và đăng nhập lại nếu cần.',
  BASELINE_INCOMPLETE: 'Chưa đọc đủ 3 bài hợp lệ. Chưa bắt đầu theo dõi.',
  UNUSABLE_WINDOW: 'Phản hồi danh sách chưa hợp lệ. Giữ nguyên danh sách thành công trước đó.',
  SERVER_TIME_REQUIRED: 'Không lấy được giờ Facebook để xác minh bài mới.',
  POST_TIME_INVALID: 'Thời gian bài không khớp giờ Facebook. Chưa tạo tương tác.',
  READ_FAILED: 'Không đọc được Facebook. Kiểm tra mạng hoặc tab nguồn.',
  NETWORK_ACCESS_DENIED: 'Kết nối tới Facebook bị chặn. Hãy mở lại tool bằng Start-Tool.cmd; nếu vẫn lỗi, kiểm tra tường lửa hoặc quyền truy cập mạng của trình duyệt.',
  READ_TIMEOUT: 'Facebook phản hồi quá thời gian chờ.',
  RESPONSE_LIMIT: 'Phản hồi vượt giới hạn đọc cho phép.',
  BROWSER_UNAVAILABLE: 'Không mở được Chrome/Edge. Kiểm tra trình duyệt đã cài trên máy.',
  BROWSER_PROFILE_BUSY: 'Hồ sơ trình duyệt riêng của tool đang được mở ở tiến trình khác. Đóng cửa sổ tool cũ rồi mở lại.',
  BACKGROUND_TAB_UNAVAILABLE: 'Không tạo được tab chạy nền. Đã dừng thao tác; hãy kiểm tra hoặc mở lại tool.',
  POST_UNVERIFIED: 'Chưa xác minh được đúng bài gốc trên tab thao tác.',
  UI_UNSUPPORTED: 'Chưa nhận diện chắc chắn thao tác trên giao diện Facebook hiện tại.',
  REACTION_UNVERIFIED: 'Bài đã có cảm xúc hoặc chưa xác minh được trạng thái Like. Chưa tự thay đổi cảm xúc.',
  AUDIENCE_UNVERIFIED: 'Chưa xác minh được đối tượng xem bài chia sẻ. Chưa gửi chia sẻ.',
  DESTINATION_UNVERIFIED: 'Chưa xác minh được chia sẻ về trang cá nhân và đúng bài gốc.',
  RESULT_UNCONFIRMED: 'Đã bắt đầu gửi nhưng chưa xác nhận được kết quả. Cần kiểm tra thủ công trước khi gửi lại.',
  STOPPED: 'Đã dừng. Các thao tác chưa gửi sẽ không được gửi tiếp.',
  JOB_NOT_RETRYABLE: 'Chỉ tiếp tục thao tác chắc chắn chưa gửi; kết quả chưa rõ cần kiểm tra thủ công.',
  JOB_HISTORY_EXPIRED: 'Bài này đã được ghi nhận trước đây và kết quả cũ đã hết hạn lưu.',
  TEST_SOURCE_ONLY: 'Chức năng thử bài có sẵn chỉ áp dụng cho nguồn Nguồn thử nghiệm trong chế độ test.',
  NO_BASELINE: 'Hãy lấy mốc 3 bài trước.',
  DATABASE_FAILED: 'Không lưu được dữ liệu. Đã dừng để tránh mất trạng thái hoặc gửi trùng.',
};
export function errorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && /^(?:ERR_SQLITE|SQLITE_)/.test(String(error.code))) return 'DATABASE_FAILED';
  const code = error instanceof Error ? error.message : '';
  if (/\bnet::ERR_NETWORK_ACCESS_DENIED\b/.test(code)) return 'NETWORK_ACCESS_DENIED';
  return Object.hasOwn(MESSAGES, code) ? code : 'READ_FAILED';
}
export function message(code: string): string { return MESSAGES[code] || MESSAGES.READ_FAILED; }
