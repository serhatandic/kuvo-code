import SwiftUI

/// An attachment loader that fetches images from URLs.
///
/// `URLAttachmentLoader` resolves URLs relative to an optional base URL, loads the image, and
/// builds an attachment value from it.
///
/// You can’t create `URLAttachmentLoader` directly. Use ``AttachmentLoader/image(relativeTo:)``
/// and ``AttachmentLoader/emoji(relativeTo:)`` instead.
public struct URLAttachmentLoader<Content: Attachment>: AttachmentLoader {
  private let baseURL: URL?
  private let content: @Sendable (Image, String) -> Content
  /// Kuvo: only files on disk, nothing from the network.
  private let filesOnly: Bool

  fileprivate init(baseURL: URL?, filesOnly: Bool = false, content: @Sendable @escaping (Image, String) -> Content) {
    self.baseURL = baseURL
    self.filesOnly = filesOnly
    self.content = content
  }

  public func attachment(
    for url: URL,
    text: String,
    environment: ColorEnvironmentValues
  ) async throws -> some Attachment {
    let imageURL = URL(string: url.absoluteString, relativeTo: baseURL) ?? url
    if filesOnly, !imageURL.isFileURL { throw URLError(.unsupportedURL) }
    let image = try await ImageLoader.shared.image(for: imageURL)

    return content(image, text)
  }
}

extension AttachmentLoader where Self == URLAttachmentLoader<ImageAttachment> {
  /// Loads images referenced by URLs.
  ///
  /// - Parameter baseURL: The base URL used to resolve relative URLs.
  public static func image(relativeTo baseURL: URL? = nil) -> Self {
    .init(baseURL: baseURL, content: ImageAttachment.init(image:text:))
  }

  /// Loads only images that are files, relative to `baseURL`: a document's own pictures, never
  /// one from the network (Kuvo).
  public static func localImage(relativeTo baseURL: URL) -> Self {
    .init(baseURL: baseURL, filesOnly: true, content: ImageAttachment.init(image:text:))
  }
}

extension AttachmentLoader where Self == URLAttachmentLoader<EmojiAttachment> {
  /// Loads custom emoji referenced by URL.
  ///
  /// - Parameter baseURL: The base URL used to resolve relative URLs.
  public static func emoji(relativeTo baseURL: URL? = nil) -> Self {
    .init(baseURL: baseURL, content: EmojiAttachment.init(image:text:))
  }
}
