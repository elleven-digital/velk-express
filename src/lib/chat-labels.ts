import type { FileLabels } from "@/components/attachments";
import type { ChatLabels } from "@/components/chat";
import type { Dict } from "@/lib/i18n";

/** The texts of the files UI, from a dictionary. */
export function fileLabelsOf(t: Dict): FileLabels {
  return {
    attach: t.files.attach,
    uploading: t.files.uploading,
    remove: t.files.remove,
    removeConfirm: t.files.removeConfirm,
    download: t.files.download,
    empty: t.files.empty,
    inMessage: t.files.inMessage,
    uploadFailed: t.files.uploadFailed,
    fileType: t.files.fileType,
    fileTooLarge: t.files.fileTooLarge,
    uploadUnavailable: t.files.uploadUnavailable,
    tooManyFiles: t.files.tooManyFiles,
    uploadLimit: t.files.uploadLimit,
  };
}

/** The conversation's texts, from a dictionary. `team` names the agency's side (its role next to the author). */
export function chatLabelsOf(t: Dict, team: string = t.chat.team): ChatLabels {
  return {
    placeholder: t.chat.placeholder,
    uploadError: t.chat.uploadError,
    uploadLimit: t.files.uploadLimit,
    bold: t.chat.bold,
    italic: t.chat.italic,
    list: t.chat.list,
    link: t.chat.link,
    image: t.chat.image,
    send: t.chat.send,
    reply: t.chat.reply,
    replyingTo: t.chat.replyingTo,
    cancelReply: t.chat.cancelReply,
    you: t.chat.you,
    emptyThread: t.chat.emptyThread,
    team,
    client: t.chat.client,
    replyTo: t.chat.replyTo,
    edit: t.chat.edit,
    delete: t.chat.delete,
    save: t.chat.save,
    cancelEdit: t.chat.cancelEdit,
    edited: t.chat.edited,
    editedBy: t.chat.editedBy,
    deleted: t.chat.deleted,
    deletedBy: t.chat.deletedBy,
    deleteConfirm: t.chat.deleteConfirm,
    unsent: t.chat.unsent,
    timeEvent: t.ui.timeEvent,
    files: fileLabelsOf(t),
  };
}
