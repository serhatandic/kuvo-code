import Foundation

struct DevinUsageClient: Sendable {
    static let cloudService = "exa.seat_management_pb.SeatManagementService"
    static let cloudCompatVersion = "1.108.2"

    var http: any HTTPClient

    init(http: any HTTPClient = URLSessionHTTPClient()) {
        self.http = http
    }

    func fetchUserStatus(auth: DevinAuth, apiServerURL: String) async throws -> HTTPResponse {
        guard let url = URL(string: "\(apiServerURL)/\(Self.cloudService)/GetUserStatus") else {
            throw DevinUsageError.invalidResponse
        }

        let body: [String: Any] = [
            "metadata": [
                "apiKey": auth.apiKey,
                "ideName": "devin",
                "ideVersion": Self.cloudCompatVersion,
                "extensionName": "devin",
                "extensionVersion": Self.cloudCompatVersion,
                "locale": "en"
            ]
        ]

        return try await http.send(HTTPRequest(
            method: "POST",
            url: url,
            headers: [
                "Content-Type": "application/json",
                "Connect-Protocol-Version": "1"
            ],
            body: try JSONSerialization.data(withJSONObject: body),
            timeout: 15
        ))
    }

}
