import { formatDuration, intervalToDuration } from "date-fns";

const PHONE_FORMAT_REGEX = /(\+\d{3})(\d{3})(\d{3})(\d{3})/;
function formatFileSize(bytes?: number) {
  if (!bytes) {
    return "0 Bytes";
  }
  const normalizedBytes = Number(bytes);
  if (normalizedBytes === 0) {
    return "0 Bytes";
  }
  const k = 1024;
  const dm = 2;
  const sizes = ["Bytes", "KB", "MB", "GB", "TB", "PB", "EB", "ZB", "YB"];
  const i = Math.floor(Math.log(normalizedBytes) / Math.log(k));
  return `${Number.parseFloat((normalizedBytes / k ** i).toFixed(dm))} ${sizes[i]}`;
}

export const FILE_ERROR_MESSAGES = {
  fileTooLarge(maxSize: number) {
    return `The file is too large. Max size is ${formatFileSize(maxSize)}.`;
  },
  fileInvalidType() {
    return "Invalid file type.";
  },
  tooManyFiles(maxFiles: number) {
    return `You can only add ${maxFiles} file(s).`;
  },
  fileNotSupported() {
    return "The file is not supported.";
  },
};

export const getTimeStamp = (createdAt: Date): string => {
  const now = new Date();
  const diff = (now.getTime() - createdAt.getTime()) / 1000;
  if (diff < 60) {
    return `${Math.floor(diff)} seconds ago`;
  }
  if (diff < 3600) {
    return `${Math.floor(diff / 60)} minutes ago`;
  }
  if (diff < 3600 * 24) {
    return `${Math.floor(diff / 3600)} hours ago`;
  }
  if (diff < 3600 * 24 * 7) {
    return `${Math.floor(diff / 3600 / 24)} days ago`;
  }
  if (diff < 3600 * 24 * 30) {
    return `${Math.floor(diff / 3600 / 24 / 7)} weeks ago`;
  }
  if (diff < 3600 * 24 * 365) {
    return `${Math.floor(diff / 3600 / 24 / 30)} months ago`;
  }
  return `${Math.floor(diff / 3600 / 24 / 365)} years ago`;
};

export const removeHTMLTags = (str: string): string => {
  const regex = /<[^>]*>/g;
  return str.replace(regex, "");
};

export const calculateTimeRemaining = (targetDate: string) => {
  const currentDate = new Date();

  const duration = intervalToDuration({
    start: currentDate,
    end: new Date(targetDate),
  });
  const formattedCountdown = formatDuration(duration, {
    format: ["years", "months", "weeks", "days", "hours"],
  });

  return formattedCountdown;
};

export const formatNumber = (num: number): string => {
  if (num === 0) {
    return "0";
  }

  const absNumber = Math.abs(num);
  if (absNumber < 1000) {
    return num.toString();
  }
  if (absNumber < 1e6) {
    return `${(num / 1000).toFixed(2)}K`;
  }
  if (absNumber < 1e9) {
    return `${(num / 1e6).toFixed(2)}M`;
  }
  return `${(num / 1e9).toFixed(2)}B`;
};

export const generateRandomColor = () => {
  const letters = "0123456789ABCDEF";
  let color = "#";
  for (let i = 0; i < 6; i++) {
    color += letters[Math.floor(Math.random() * 16)];
  }
  return `bg-[${color}]/10`;
};

export const convertEnumToString = (label: string) => {
  return label?.replace(/_/g, " ").toLowerCase();
};

// Removed unused getDateFromMonthYear

export const maskRwandanPhoneNumber = (phoneNumber: string) => {
  // Remove any non-digit characters
  const cleanedNumber = phoneNumber.replace(/\D/g, "");

  // Check if it's a valid Rwandan phone number (should be 12 digits including country code)
  if (cleanedNumber.length !== 12 || !cleanedNumber.startsWith("250")) {
    return "Invalid Rwandan phone number";
  }

  // Keep the country code (250) and last 3 digits
  const maskedNumber = `+250 *** *** *${cleanedNumber.slice(-3)}`;

  return maskedNumber;
};

export const formatPhoneNumber = (phoneNumber: string) => {
  return phoneNumber.replace(PHONE_FORMAT_REGEX, "$1 $2 $3 $4");
};

export const generatePatientId = () => {
  const prefix = "PAT";
  //Generate a random string of 6 characters
  const randomString = Math.random().toString(36).substring(2, 8).toUpperCase();
  return `${prefix}-${randomString}`;
};

export const parseNationalityFromPhoneNumber = (phoneNumber: string) => {
  const knownCountryCodes = [
    {
      code: "+250",
      country: "Rwanda",
    },
    {
      code: "+254",
      country: "Kenya",
    },
    {
      code: "+255",
      country: "Tanzania",
    },
    {
      code: "+256",
      country: "Uganda",
    },
    {
      code: "+257",
      country: "Burundi",
    },
    {
      code: "+258",
      country: "Mozambique",
    },
    {
      code: "+260",
      country: "Zambia",
    },
    {
      code: "+263",
      country: "Zimbabwe",
    },
    {
      code: "+243",
      country: "Democratic Republic of the Congo",
    },
    {
      code: "+242",
      country: "Republic of the Congo",
    },
    {
      code: "+1",
      country: "United States",
    },
  ];

  for (const countryCodes of knownCountryCodes) {
    if (phoneNumber.startsWith(countryCodes.code)) {
      return countryCodes.country;
    }
  }

  return "Unknown";
};
